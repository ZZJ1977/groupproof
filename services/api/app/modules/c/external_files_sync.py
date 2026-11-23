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
import mimetypes
import re
from datetime import UTC, datetime
from pathlib import PurePosixPath
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
    if not receipt.content_hash or receipt.size_bytes is None or not receipt.revision:
        return False
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
        storage_revision=receipt.revision,
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
) -> bool:
    if not data or len(data) > MAX_FILE_BYTES:
        return False
    digest = hashlib.sha256(data).hexdigest()
    existing = _find_logical_file(session, project_id, logical_name)
    if existing is not None:
        latest = _latest_version(session, existing)
        if latest is not None and latest.content_hash == digest:
            return False
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
                md_body = (
                    f"# {title or fallback_title}\n\n"
                    f"> 来源：飞书云文档（{url}）\n\n"
                    f"{content.strip()}\n"
                ).encode()
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

    if resolved_storage is None:
        warnings.append("文件存储尚未配置，暂时无法将 GitHub README 或飞书群文档写入项目资料库。")
    else:
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
