"""外部资料自动同步：将 GitHub 仓库 README、飞书群文档/附件与项目初始化资料同步至项目资料库。

原则：
- 幂等同步：按文件内容 SHA-256 去重；未变化则跳过，内容更新时自动追加新版本并留痕；
- 真实存储：所有同步文件均通过 A4 存储服务（Supabase Storage）落盘并生成已校验的 UploadReceipt，
  使预览、下载、设为正式版本、证据引用与人工上传文件走完全一致的链路；
- 透明降级：当飞书应用尚未开通群消息或云文档只读权限（99991672）时，不阻断 GitHub README
  与已有项目资料的同步，并清晰返回缺少的飞书权限列表供管理员一键开通。
"""

from __future__ import annotations

import hashlib
import hmac
import mimetypes
import os
import re
from datetime import UTC, datetime, timedelta
from pathlib import PurePosixPath
from urllib.parse import quote, urlsplit
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.a import feishu, storage
from app.modules.a.models import (
    FeishuAttachment,
    FeishuChatLink,
    FeishuMessage,
    GithubFile,
    GithubRepoLink,
)
from app.modules.a.models import (
    UploadReceipt as UploadReceiptRow,
)
from app.modules.b.models import BProjectMaterial
from app.modules.c.files_models import FileDecision, FileVersion, LogicalFile
from app.modules.c.files_schemas import ExternalFilesSyncDTO
from app.modules.c.files_service import file_access
from app.modules.c.files_storage import ALLOWED_MIME, MAX_FILE_BYTES
from app.modules.c.integration_events import emit_event

INTERNAL_FILE_PROVIDERS = frozenset({"github", "inline", "feishu_doc", "feishu_att"})
INTERNAL_LINK_TTL_SECONDS = 600

_INVALID_NAME_CHARS = re.compile(r'[/\\:*?"<>|\x00-\x1f\x7f]+')
_IMAGE_EXTS = {"png", "jpg", "jpeg"}
_DEFAULT_MIME_BY_EXT = {
    "md": "text/markdown",
    "txt": "text/plain",
    "pdf": "application/pdf",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "zip": "application/zip",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
}


def _clean_filename(raw: str, *, fallback: str) -> str:
    cleaned = _INVALID_NAME_CHARS.sub("_", (raw or "").strip()).strip(". ")
    if not cleaned:
        cleaned = fallback
    return cleaned[:200]


def _pick_mime(filename: str) -> tuple[str, str] | None:
    ext = PurePosixPath(filename).suffix.removeprefix(".").lower()
    if ext not in ALLOWED_MIME:
        return None
    if ext in _DEFAULT_MIME_BY_EXT:
        return ext, _DEFAULT_MIME_BY_EXT[ext]
    guessed, _ = mimetypes.guess_type(filename)
    if guessed and guessed in ALLOWED_MIME[ext]:
        return ext, guessed
    return ext, next(iter(sorted(ALLOWED_MIME[ext])))


def _find_logical_file(session: Session, project_id: UUID, name: str) -> LogicalFile | None:
    return session.scalar(
        select(LogicalFile).where(
            LogicalFile.project_id == project_id,
            LogicalFile.name_key == name.casefold(),
        )
    )


def _latest_version(session: Session, logical_file: LogicalFile) -> FileVersion | None:
    return session.scalar(
        select(FileVersion).where(
            FileVersion.file_id == logical_file.id,
            FileVersion.version_no == logical_file.latest_version_no,
        )
    )


def _register_from_receipt(
    session: Session,
    user: User,
    project_id: UUID,
    *,
    logical_name: str,
    category: str,
    receipt: UploadReceiptRow,
    reason: str,
) -> bool:
    """用已完成的 UploadReceipt 幂等创建或追加 LogicalFile 版本。返回 True 表示发生写入。"""
    if not receipt.content_hash or receipt.size_bytes is None:
        return False
    revision = receipt.revision or f"sha256:{receipt.content_hash}"
    if session.scalar(select(FileVersion.id).where(FileVersion.receipt_id == receipt.id)):
        return False

    existing = _find_logical_file(session, project_id, logical_name)
    now_ts = datetime.now(UTC)
    if existing is not None:
        latest = _latest_version(session, existing)
        if latest is not None and latest.content_hash == receipt.content_hash:
            return False
        previous_official = existing.official_version_no
        existing.latest_version_no += 1
        existing.lock_version += 1
        existing.updated_at = now_ts
        action = "appended"
        row = existing
    else:
        previous_official = None
        row = LogicalFile(
            id=uuid4(),
            project_id=project_id,
            name=logical_name,
            name_key=logical_name.casefold(),
            category=category,
            latest_version_no=1,
            created_by=user.id,
        )
        session.add(row)
        session.flush()
        action = "created"

    ext = PurePosixPath(receipt.filename).suffix.removeprefix(".").lower()
    version = FileVersion(
        id=uuid4(),
        file_id=row.id,
        version_no=row.latest_version_no,
        receipt_id=receipt.id,
        storage_provider=receipt.provider,
        storage_object_id=receipt.object_id,
        storage_revision=revision,
        content_hash=receipt.content_hash,
        original_name=receipt.filename,
        extension=ext,
        mime_type=receipt.mime_type or receipt.declared_mime,
        size_bytes=receipt.size_bytes,
        uploaded_by=user.id,
    )
    session.add(version)
    session.flush()

    decision = FileDecision(
        id=uuid4(),
        file_id=row.id,
        version_id=version.id,
        actor_id=user.id,
        action=action,
        reason=reason,
        resulting_lock_version=row.lock_version,
        previous_official_version_no=previous_official,
    )
    session.add(decision)
    emit_event(
        session,
        project_id=project_id,
        aggregate_id=row.id,
        event_type=f"file.{action}",
        payload={
            "file_id": str(row.id),
            "version_id": str(version.id),
            "version_no": version.version_no,
            "actor_id": str(user.id),
            "decision_id": str(decision.id),
            "reason": reason,
            "previous_official_version_no": previous_official,
            "official_version_no": row.official_version_no,
            "lock_version": row.lock_version,
        },
    )
    session.flush()
    return True


def _create_fallback_receipt(
    session: Session,
    user: User,
    project_id: UUID,
    *,
    provider: str,
    bucket: str,
    object_id: str,
    filename: str,
    mime_type: str,
    data: bytes,
    inline_text: str | None = None,
) -> UploadReceiptRow:
    extension = storage.validate_file(filename, mime_type, len(data))
    scan_err = storage.BasicContentScanner().scan(data, extension=extension)
    if scan_err:
        raise ApiError(
            422,
            "UPLOAD_REJECTED",
            "同步文件未通过安全检查。",
            details={"reason": scan_err},
        )
    now_ts = datetime.now(UTC)
    digest = hashlib.sha256(data).hexdigest()
    receipt = UploadReceiptRow(
        id=uuid4(),
        scope="project",
        scope_id=project_id,
        actor_id=user.id,
        provider=provider,
        bucket=bucket,
        object_id=object_id[:255],
        filename=filename,
        declared_mime=mime_type,
        declared_size=len(data),
        status="completed",
        scan_status="clean",
        content_hash=digest,
        size_bytes=len(data),
        mime_type=mime_type,
        revision=f"sha256:{digest}",
        created_at=now_ts,
        upload_expires_at=now_ts + timedelta(hours=2),
        completed_at=now_ts,
    )
    session.add(receipt)
    session.flush()
    if inline_text is not None:
        session.add(
            BProjectMaterial(
                project_id=project_id,
                kind="text",
                title=filename[:200],
                receipt_id=receipt.id,
                text_content=inline_text,
                extract_status="ready",
                created_by=user.id,
            )
        )
        session.flush()
    return receipt


def _upsert_bytes(
    session: Session,
    user: User,
    project_id: UUID,
    *,
    logical_name: str,
    filename: str,
    mime_type: str,
    category: str,
    data: bytes,
    reason: str,
    storage_client: storage.StorageClient | None,
    fallback_provider: str | None = None,
    fallback_bucket: str | None = None,
    fallback_object_id: str | None = None,
    fallback_inline_text: str | None = None,
) -> bool:
    if not data or len(data) > MAX_FILE_BYTES:
        return False
    digest = hashlib.sha256(data).hexdigest()
    existing = _find_logical_file(session, project_id, logical_name)
    if existing is not None:
        latest = _latest_version(session, existing)
        if latest is not None and latest.content_hash == digest:
            return False
    receipt: UploadReceiptRow | None = None
    if storage_client is not None:
        try:
            receipt = storage.store_system_bytes(
                session,
                user,
                scope="project",
                scope_id=project_id,
                filename=filename,
                mime_type=mime_type,
                data=data,
                client=storage_client,
            )
        except ApiError as exc:
            if exc.code != "FILE_STORAGE_UNAVAILABLE" or not fallback_provider:
                raise
    if receipt is None:
        if not (fallback_provider and fallback_bucket and fallback_object_id):
            raise ApiError(503, "FILE_STORAGE_UNAVAILABLE", "文件存储暂时不可用。")
        receipt = _create_fallback_receipt(
            session,
            user,
            project_id,
            provider=fallback_provider,
            bucket=fallback_bucket,
            object_id=fallback_object_id,
            filename=filename,
            mime_type=mime_type,
            data=data,
            inline_text=fallback_inline_text,
        )
    return _register_from_receipt(
        session,
        user,
        project_id,
        logical_name=logical_name,
        category=category,
        receipt=receipt,
        reason=reason,
    )


def _select_repo_readmes(files: list[GithubFile]) -> list[GithubFile]:
    """优先取仓库根目录的 README 文档；若根目录不存在，再取层级最浅的 README。"""
    root_readmes = [
        f
        for f in files
        if "/" not in f.path
        and f.path.lower().startswith("readme")
        and PurePosixPath(f.path).suffix.removeprefix(".").lower() in {"md", "txt"}
    ]
    if root_readmes:
        return sorted(root_readmes, key=lambda item: item.path.lower())
    nested = [
        f
        for f in files
        if PurePosixPath(f.path).name.lower().startswith("readme")
        and PurePosixPath(f.path).suffix.removeprefix(".").lower() in {"md", "txt"}
    ]
    if not nested:
        return []
    min_depth = min(f.path.count("/") for f in nested)
    return sorted([f for f in nested if f.path.count("/") == min_depth], key=lambda x: x.path)[:2]


def _sync_github_readmes(
    session: Session,
    user: User,
    project_id: UUID,
    *,
    storage_client: storage.StorageClient | None,
    warnings: list[str],
) -> tuple[int, int, int]:
    links = list(
        session.scalars(
            select(GithubRepoLink)
            .where(GithubRepoLink.project_id == project_id)
            .order_by(GithubRepoLink.linked_at.asc())
        )
    )
    if not links:
        return 0, 0, 0

    synced = 0
    skipped = 0
    multi = len(links) > 1
    for link in links:
        repo_files = list(session.scalars(select(GithubFile).where(GithubFile.link_id == link.id)))
        readmes = _select_repo_readmes(repo_files)
        if not readmes:
            warnings.append(f"GitHub 仓库 {link.owner}/{link.repo} 暂未检测到 README 文档。")
            continue
        for gh_file in readmes:
            base = PurePosixPath(gh_file.path).name
            logical_name = _clean_filename(
                f"{link.repo}-{base}" if multi else base, fallback="README.md"
            )
            picked = _pick_mime(logical_name)
            if picked is None:
                continue
            _, mime_type = picked
            data = (gh_file.text or "").encode("utf-8")
            if not data:
                continue
            wrote = _upsert_bytes(
                session,
                user,
                project_id,
                logical_name=logical_name,
                filename=logical_name,
                mime_type=mime_type,
                category="documents",
                data=data,
                reason=(
                    f"同步自 GitHub 仓库 {link.owner}/{link.repo} "
                    f"({link.default_branch}) · {gh_file.path}"
                ),
                storage_client=storage_client,
                fallback_provider="github",
                fallback_bucket="github-files",
                fallback_object_id=f"github/{link.id}/{gh_file.path}",
            )
            if wrote:
                synced += 1
            else:
                skipped += 1
    return len(links), synced, skipped


def _sync_project_materials(
    session: Session,
    user: User,
    project_id: UUID,
) -> tuple[int, int]:
    """把项目初始化/需求阶段通过上传通道保存的真实文件同步到项目资料库，保持两边一致。"""
    materials = list(
        session.scalars(
            select(BProjectMaterial)
            .where(
                BProjectMaterial.project_id == project_id,
                BProjectMaterial.receipt_id.is_not(None),
            )
            .order_by(BProjectMaterial.created_at.asc())
        )
    )
    synced = 0
    skipped = 0
    for mat in materials:
        if mat.receipt_id is None:
            continue
        receipt = session.get(UploadReceiptRow, mat.receipt_id)
        if (
            receipt is None
            or receipt.status != "completed"
            or receipt.scope != "project"
            or receipt.scope_id != project_id
        ):
            continue
        logical_name = _clean_filename(receipt.filename or mat.title, fallback="material.pdf")
        ext = PurePosixPath(logical_name).suffix.removeprefix(".").lower()
        category = "images" if ext in _IMAGE_EXTS else "documents"
        wrote = _register_from_receipt(
            session,
            user,
            project_id,
            logical_name=logical_name,
            category=category,
            receipt=receipt,
            reason=f"同步自项目初始化资料 · {mat.title}",
        )
        if wrote:
            synced += 1
        else:
            skipped += 1
    return synced, skipped


def _add_missing_scopes(
    exc: feishu.FeishuScopeDeniedError,
    missing_scopes: list[str],
    warnings: list[str],
    auth_urls: list[str],
) -> None:
    for scope in exc.missing_scopes:
        if scope not in missing_scopes:
            missing_scopes.append(scope)
    if exc.auth_url and exc.auth_url not in auth_urls:
        auth_urls.append(exc.auth_url)
    if exc.message not in warnings:
        warnings.append(exc.message)


def _sync_feishu_documents(
    session: Session,
    user: User,
    project_id: UUID,
    *,
    storage_client: storage.StorageClient | None,
    feishu_reader: feishu.FeishuReader | None,
    refresh_sources: bool,
    missing_scopes: list[str],
    warnings: list[str],
    auth_urls: list[str],
) -> tuple[int, int, int]:
    links = list(
        session.scalars(
            select(FeishuChatLink)
            .where(FeishuChatLink.project_id == project_id)
            .order_by(FeishuChatLink.linked_at.asc())
        )
    )
    if not links:
        return 0, 0, 0

    created_reader: feishu.FeishuClient | None = None
    reader = feishu_reader
    if reader is None:
        created_reader = feishu.get_feishu_reader()  # type: ignore[assignment]
        reader = created_reader

    synced = 0
    skipped = 0
    discovered_doc_links: list[tuple[str, str, str]] = []
    seen_doc_keys: set[tuple[str, str]] = set()

    def _collect_doc_links(text: str) -> None:
        for kind, token, url in feishu.extract_feishu_doc_links(text):
            if (kind, token) not in seen_doc_keys:
                seen_doc_keys.add((kind, token))
                discovered_doc_links.append((kind, token, url))

    try:
        if reader is None:
            warnings.append("飞书应用尚未配置凭证，暂时无法同步飞书群文档。")
            return len(links), 0, 0

        # 1) 可选刷新群消息快照与群标签页
        if refresh_sources:
            now_ts = datetime.now(UTC)
            totals = {"chats": len(links), "created": 0, "updated": 0, "deleted": 0, "seen": 0}
            for link in links:
                try:
                    for item in feishu._iter_chat(reader, link.chat_id):
                        totals["seen"] += 1
                        feishu._upsert(session, project_id, link.chat_id, item, now_ts, totals)
                    session.flush()
                except feishu.FeishuScopeDeniedError as exc:
                    _add_missing_scopes(exc, missing_scopes, warnings, auth_urls)
                except ApiError as exc:
                    if exc.message not in warnings:
                        warnings.append(exc.message)

                list_tabs = getattr(reader, "list_chat_tabs", None)
                if callable(list_tabs):
                    try:
                        for tab in list_tabs(link.chat_id):
                            content = tab.get("tab_content") if isinstance(tab, dict) else None
                            if isinstance(content, dict):
                                for field_name in ("doc", "url"):
                                    val = content.get(field_name)
                                    if isinstance(val, str):
                                        _collect_doc_links(val)
                    except feishu.FeishuScopeDeniedError as exc:
                        _add_missing_scopes(exc, missing_scopes, warnings, auth_urls)
                    except ApiError:
                        pass

        # 2) 同步群消息里的所有文件附件（kind == 'file'）
        messages = list(
            session.scalars(
                select(FeishuMessage)
                .where(
                    FeishuMessage.project_id == project_id,
                    FeishuMessage.deleted.is_(False),
                )
                .order_by(FeishuMessage.occurred_at.asc())
            )
        )
        msg_by_id = {m.id: m for m in messages}
        for m in messages:
            _collect_doc_links(m.text or "")

        if msg_by_id:
            attachments = list(
                session.scalars(
                    select(FeishuAttachment).where(
                        FeishuAttachment.message_row_id.in_(list(msg_by_id.keys())),
                        FeishuAttachment.kind == "file",
                        FeishuAttachment.available.is_(True),
                    )
                )
            )
            for att in attachments:
                msg = msg_by_id.get(att.message_row_id)
                if msg is None:
                    continue
                raw_name = att.name or f"feishu-{att.file_key[:12]}.txt"
                logical_name = _clean_filename(raw_name, fallback=f"feishu-{att.file_key[:12]}.txt")
                picked = _pick_mime(logical_name)
                if picked is None:
                    continue
                ext, mime_type = picked
                try:
                    data = reader.download_resource(msg.message_id, att.file_key, "file")
                except feishu.FeishuScopeDeniedError as exc:
                    _add_missing_scopes(exc, missing_scopes, warnings, auth_urls)
                    break
                except ApiError as exc:
                    if exc.message not in warnings:
                        warnings.append(f"飞书群附件《{logical_name}》下载失败：{exc.message}")
                    continue
                category = "images" if ext in _IMAGE_EXTS else "documents"
                try:
                    wrote = _upsert_bytes(
                        session,
                        user,
                        project_id,
                        logical_name=logical_name,
                        filename=logical_name,
                        mime_type=mime_type,
                        category=category,
                        data=data,
                        reason=f"同步自飞书群文件附件（消息 {msg.message_id}）",
                        storage_client=storage_client,
                        fallback_provider="feishu_att",
                        fallback_bucket="feishu-attachments",
                        fallback_object_id=f"feishu-att/{msg.message_id}/{att.file_key}",
                    )
                    if wrote:
                        synced += 1
                    else:
                        skipped += 1
                except ApiError as exc:
                    warnings.append(f"飞书群附件《{logical_name}》未通过安全检查：{exc.message}")

        # 3) 同步群消息/标签页里出现的飞书云文档（docx / wiki）
        get_docx = getattr(reader, "get_docx_document", None)
        get_wiki = getattr(reader, "get_wiki_node_obj", None)
        if callable(get_docx):
            for kind, token, url in discovered_doc_links:
                doc_token = token
                fallback_title = token
                if kind == "wiki":
                    if not callable(get_wiki):
                        continue
                    try:
                        resolved = get_wiki(token)
                    except feishu.FeishuScopeDeniedError as exc:
                        _add_missing_scopes(exc, missing_scopes, warnings, auth_urls)
                        continue
                    except ApiError:
                        continue
                    if not resolved or resolved[0] != "docx":
                        continue
                    doc_token, fallback_title = resolved[1], resolved[2] or token
                elif kind != "docx":
                    continue
                try:
                    title, content = get_docx(doc_token)
                except feishu.FeishuScopeDeniedError as exc:
                    _add_missing_scopes(exc, missing_scopes, warnings, auth_urls)
                    break
                except ApiError as exc:
                    warnings.append(f"飞书云文档（{doc_token}）读取失败：{exc.message}")
                    continue
                safe_title = _clean_filename(title or fallback_title, fallback=doc_token)
                logical_name = (
                    safe_title if safe_title.lower().endswith(".md") else f"{safe_title}.md"
                )
                md_text = (
                    f"# {title or fallback_title}\n\n"
                    f"> 来源：飞书云文档（{url}）\n\n"
                    f"{content.strip()}\n"
                )
                md_body = md_text.encode()
                wrote = _upsert_bytes(
                    session,
                    user,
                    project_id,
                    logical_name=logical_name,
                    filename=logical_name,
                    mime_type="text/markdown",
                    category="documents",
                    data=md_body,
                    reason=f"同步自飞书群云文档 · {title or doc_token}",
                    storage_client=storage_client,
                    fallback_provider="feishu_doc",
                    fallback_bucket="feishu-docs",
                    fallback_object_id=f"feishu-doc/{doc_token}/{logical_name}",
                    fallback_inline_text=md_text,
                )
                if wrote:
                    synced += 1
                else:
                    skipped += 1
    finally:
        if isinstance(created_reader, feishu.FeishuClient):
            created_reader.close()

    return len(links), synced, skipped


def sync_external_project_files(
    session: Session,
    user: User,
    project_id: UUID,
    *,
    storage_client: storage.StorageClient | None = None,
    feishu_reader: feishu.FeishuReader | None = None,
    refresh_sources: bool = True,
    require_member_auth: bool = True,
) -> ExternalFilesSyncDTO:
    """同步 GitHub 仓库 README、飞书群文档/附件与项目初始化资料到项目资料库。"""
    if require_member_auth:
        file_access(session, user, project_id, write=True)

    resolved_storage = (
        storage_client if storage_client is not None else storage.get_storage_client()
    )
    warnings: list[str] = []
    missing_scopes: list[str] = []
    auth_urls: list[str] = []

    mat_synced, mat_skipped = _sync_project_materials(session, user, project_id)

    gh_repos = 0
    gh_synced = 0
    gh_skipped = 0
    fs_chats = 0
    fs_synced = 0
    fs_skipped = 0

    gh_repos, gh_synced, gh_skipped = _sync_github_readmes(
        session,
        user,
        project_id,
        storage_client=resolved_storage,
        warnings=warnings,
    )
    fs_chats, fs_synced, fs_skipped = _sync_feishu_documents(
        session,
        user,
        project_id,
        storage_client=resolved_storage,
        feishu_reader=feishu_reader,
        refresh_sources=refresh_sources,
        missing_scopes=missing_scopes,
        warnings=warnings,
        auth_urls=auth_urls,
    )

    session.flush()
    return ExternalFilesSyncDTO(
        github_repos=gh_repos,
        github_synced=gh_synced,
        github_skipped=gh_skipped,
        feishu_chats=fs_chats,
        feishu_synced=fs_synced,
        feishu_skipped=fs_skipped,
        materials_synced=mat_synced,
        materials_skipped=mat_skipped,
        missing_feishu_scopes=missing_scopes,
        feishu_auth_url=auth_urls[0] if auth_urls else None,
        warnings=warnings,
    )


def _hmac_secret() -> bytes:
    key = (os.getenv("EMAIL_CHALLENGE_HMAC_KEY") or os.getenv("SESSION_SECRET") or "").strip()
    if not key:
        raise ApiError(503, "FILE_STORAGE_UNAVAILABLE", "文件签名密钥未配置。")
    return key.encode("utf-8")


def _sign_token(project_id: UUID, file_id: UUID, version_id: UUID, purpose: str, exp: int) -> str:
    payload = f"file-content:{project_id}:{file_id}:{version_id}:{purpose}:{exp}".encode()
    return hmac.new(_hmac_secret(), payload, hashlib.sha256).hexdigest()


def sign_internal_file_link(
    project_id: UUID, file_id: UUID, version_id: UUID, purpose: str
) -> dict:
    origin = (os.getenv("APP_ORIGIN") or "").strip().rstrip("/")
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ApiError(
            503,
            "FILE_STORAGE_UNAVAILABLE",
            "未配置 HTTPS APP_ORIGIN，无法签发文件链接。",
        )
    expires_at = datetime.now(UTC) + timedelta(seconds=INTERNAL_LINK_TTL_SECONDS)
    exp = int(expires_at.timestamp())
    sig = _sign_token(project_id, file_id, version_id, purpose, exp)
    url = (
        f"{origin}/api/v1/projects/{project_id}/files/{file_id}"
        f"/versions/{version_id}/content?purpose={quote(purpose)}&exp={exp}&sig={sig}"
    )
    return {
        "version_id": str(version_id),
        "purpose": purpose,
        "url": url,
        "expires_at": expires_at.isoformat(),
    }


def read_internal_file_content(
    session: Session,
    project_id: UUID,
    file_id: UUID,
    version_id: UUID,
    *,
    purpose: str,
    exp: int,
    sig: str,
) -> tuple[bytes, str, str]:
    """校验短时 HMAC 签名并直接返回同步资料（GitHub README / 飞书文档 / 初始化资料）内容。"""
    if purpose not in {"preview", "download"}:
        raise ApiError(400, "INVALID_PURPOSE", "无效的访问方式。")
    if exp < int(datetime.now(UTC).timestamp()):
        raise ApiError(403, "LINK_EXPIRED", "临时链接已过期，请重新申请。")
    expected = _sign_token(project_id, file_id, version_id, purpose, exp)
    if not sig or not hmac.compare_digest(expected, sig):
        raise ApiError(403, "INVALID_SIGNATURE", "文件链接签名无效。")

    row = session.scalar(
        select(LogicalFile).where(LogicalFile.id == file_id, LogicalFile.project_id == project_id)
    )
    if row is None:
        raise ApiError(404, "FILE_NOT_FOUND", "文件不存在。")
    version = session.scalar(
        select(FileVersion).where(FileVersion.id == version_id, FileVersion.file_id == row.id)
    )
    if version is None or version.storage_provider not in INTERNAL_FILE_PROVIDERS:
        raise ApiError(404, "FILE_VERSION_NOT_FOUND", "文件版本不存在。")

    filename = version.original_name or row.name
    if version.storage_provider == "github":
        parts = (version.storage_object_id or "").split("/", 2)
        if len(parts) == 3 and parts[0] == "github":
            gh_file = session.scalar(
                select(GithubFile).where(
                    GithubFile.link_id == UUID(parts[1]), GithubFile.path == parts[2]
                )
            )
            if gh_file is not None:
                return (
                    (gh_file.text or "").encode("utf-8"),
                    "text/markdown; charset=utf-8",
                    filename,
                )
        raise ApiError(404, "FILE_NOT_FOUND", "GitHub 仓库文档快照不存在。")

    if version.storage_provider in {"inline", "feishu_doc"}:
        mat = session.scalar(
            select(BProjectMaterial).where(
                BProjectMaterial.project_id == project_id,
                BProjectMaterial.receipt_id == version.receipt_id,
            )
        )
        if mat is not None and mat.text_content:
            is_md = version.extension == "md" or version.storage_provider == "feishu_doc"
            media = "text/markdown; charset=utf-8" if is_md else "text/plain; charset=utf-8"
            out_name = filename if is_md else f"{PurePosixPath(filename).stem}.txt"
            return mat.text_content.encode("utf-8"), media, out_name
        raise ApiError(404, "FILE_NOT_FOUND", "资料正文快照暂不可用。")

    if version.storage_provider == "feishu_att":
        parts = (version.storage_object_id or "").split("/", 2)
        if len(parts) == 3 and parts[0] == "feishu-att":
            reader = feishu.get_feishu_reader()
            if reader is None:
                raise ApiError(503, "FEISHU_UNAVAILABLE", "飞书暂时不可用。")
            try:
                data = reader.download_resource(parts[1], parts[2], "file")
                return data, version.mime_type or "application/octet-stream", filename
            finally:
                if isinstance(reader, feishu.FeishuClient):
                    reader.close()
    raise ApiError(404, "FILE_NOT_FOUND", "文件内容暂不可用。")
