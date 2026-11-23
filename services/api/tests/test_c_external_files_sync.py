"""外部项目资料同步回归测试：GitHub README、飞书群文档/附件与项目初始化资料。"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import JSON, DefaultClause, MetaData, create_engine, event, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapper, Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import Project, ProjectMember
from app.modules.a import feishu
from app.modules.a.models import (
    FeishuChatLink,
    GithubFile,
    GithubRepoLink,
    UploadReceipt,
)
from app.modules.b.models import BProjectMaterial
from app.modules.c.external_files_sync import sync_external_project_files
from app.modules.c.files_models import FileVersion, LogicalFile
from tests.b_fixtures import _user, b_postgres_schema, b_test_database_url


class MemoryStorageClient:
    host = "memory.supabase.co"
    bucket = "test-bucket"

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def create_signed_upload_url(self, object_id: str) -> str:
        return f"https://{self.host}/upload/{object_id}"

    def upload_bytes(self, object_id: str, data: bytes, mime_type: str) -> None:
        self.objects[object_id] = data

    def download(self, object_id: str, *, max_bytes: int) -> bytes:
        return self.objects[object_id]

    def create_signed_download_url(self, object_id: str, expires_in: int) -> str:
        return f"https://{self.host}/download/{object_id}"


class FakeFeishuReader:
    def __init__(
        self,
        *,
        messages: list[feishu.FeishuMessageItem] | None = None,
        resources: dict[tuple[str, str], bytes] | None = None,
        docs: dict[str, tuple[str, str]] | None = None,
        tabs: list[dict] | None = None,
        scope_error: feishu.FeishuScopeDeniedError | None = None,
    ) -> None:
        self._messages = messages or []
        self._resources = resources or {}
        self._docs = docs or {}
        self._tabs = tabs or []
        self._scope_error = scope_error

    def list_chat_messages(self, chat_id: str, page_token: str | None):
        if self._scope_error is not None:
            raise self._scope_error
        return self._messages, None

    def list_bot_chats(self, page_token: str | None):
        return [], None

    def download_resource(self, message_id: str, file_key: str, resource_type: str) -> bytes:
        return self._resources[(message_id, file_key)]

    def list_chat_tabs(self, chat_id: str) -> list[dict]:
        return self._tabs

    def get_docx_document(self, doc_token: str) -> tuple[str, str]:
        return self._docs[doc_token]


@pytest.fixture
def sync_db():
    if os.getenv("B_TEST_DATABASE_URL"):
        with b_postgres_schema(b_test_database_url()) as pg_engine:
            with Session(pg_engine) as session:
                yield session
        return

    engine = create_engine(
        "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )

    @event.listens_for(engine, "connect")
    def enforce_fk(conn, _):
        conn.execute("PRAGMA foreign_keys=ON")
        conn.create_function("gen_random_uuid", 0, lambda: uuid4().hex)

    @event.listens_for(Mapper, "before_insert")
    def fill_defaults(_, __, target):
        now = datetime.now(UTC)
        for column in target.__table__.columns:
            if getattr(target, column.key, None) is not None:
                continue
            if column.primary_key and column.type.python_type is type(uuid4()):
                setattr(target, column.key, uuid4())
            elif column.key in {
                "created_at",
                "updated_at",
                "joined_at",
                "linked_at",
                "synced_at",
                "recorded_at",
            }:
                setattr(target, column.key, now)

    meta = MetaData()
    for table in Base.metadata.tables.values():
        clone = table.to_metadata(meta)
        for col in clone.columns:
            if isinstance(col.type, JSONB):
                col.type = JSON()
            if isinstance(col.server_default, DefaultClause):
                raw = str(col.server_default.arg)
                if "gen_random_uuid" in raw or "::jsonb" in raw or "now()" in raw:
                    col.server_default = None
    meta.create_all(engine)
    try:
        with Session(engine) as session:
            yield session
    finally:
        event.remove(Mapper, "before_insert", fill_defaults)
        engine.dispose()


def _seed_project(session: Session):
    now = datetime.now(UTC)
    tag = uuid4().hex[:6]
    leader = _user(session, tag=f"ext_{tag}", role="student", index=1, now=now)
    project = Project(id=uuid4(), name="GroupProof", lifecycle="active", setup_status="frozen")
    session.add(project)
    session.flush()
    session.add(ProjectMember(id=uuid4(), project_id=project.id, user_id=leader.id, role="leader"))
    session.flush()
    return leader, project


def test_syncs_github_readme_feishu_docs_and_b_materials_idempotently(sync_db):
    leader, project = _seed_project(sync_db)
    storage_client = MemoryStorageClient()

    # 1) GitHub 仓库与根目录 README.md（同时包含子目录 README，应优先同步根目录 README.md）
    gh_link = GithubRepoLink(
        id=uuid4(),
        project_id=project.id,
        owner="ZZJ1977",
        repo="groupproof",
        installation_id=101,
        default_branch="main",
        linked_by_id=leader.id,
    )
    sync_db.add(gh_link)
    sync_db.flush()
    readme_v1 = GithubFile(
        id=uuid4(),
        project_id=project.id,
        link_id=gh_link.id,
        path="README.md",
        blob_sha="a" * 40,
        size_bytes=28,
        text="# GroupProof\n\nInitial README",
    )
    nested_readme = GithubFile(
        id=uuid4(),
        project_id=project.id,
        link_id=gh_link.id,
        path="e2e/README.md",
        blob_sha="b" * 40,
        size_bytes=12,
        text="# E2E notes",
    )
    sync_db.add_all([readme_v1, nested_readme])

    # 2) 项目初始化资料（已有已完成上传凭证）
    pdf_bytes = b"%PDF-1.4\nGroupProof plan"
    pdf_hash = hashlib.sha256(pdf_bytes).hexdigest()
    now = datetime.now(UTC)
    mat_receipt = UploadReceipt(
        id=uuid4(),
        scope="project",
        scope_id=project.id,
        actor_id=leader.id,
        provider="supabase",
        bucket="test-bucket",
        object_id=f"project/{project.id}/plan/plan.pdf",
        filename="四人分工计划.pdf",
        declared_mime="application/pdf",
        declared_size=len(pdf_bytes),
        status="completed",
        scan_status="clean",
        content_hash=pdf_hash,
        size_bytes=len(pdf_bytes),
        mime_type="application/pdf",
        revision=f"sha256:{pdf_hash}",
        created_at=now,
        upload_expires_at=now + timedelta(hours=2),
        completed_at=now,
    )
    sync_db.add(mat_receipt)
    sync_db.flush()
    sync_db.add(
        BProjectMaterial(
            id=uuid4(),
            project_id=project.id,
            kind="file",
            title="四人分工计划.pdf",
            receipt_id=mat_receipt.id,
            extract_status="ready",
            text_content="分工内容",
            created_by=leader.id,
        )
    )

    # 3) 飞书群：含 1 个群文件附件 + 1 个群消息云文档链接 + 1 个群标签页云文档
    sync_db.add(
        FeishuChatLink(
            id=uuid4(),
            project_id=project.id,
            chat_id="oc_demo_chat_001",
            linked_by_id=leader.id,
        )
    )
    sync_db.flush()

    feishu_reader = FakeFeishuReader(
        messages=[
            feishu.FeishuMessageItem(
                message_id="om_file_1",
                msg_type="file",
                create_time_ms=1_732_000_000_000,
                sender_open_id="ou_1",
                sender_type="user",
                deleted=False,
                content=json.dumps({"file_key": "fk_notes", "file_name": "周会纪要.md"}),
            ),
            feishu.FeishuMessageItem(
                message_id="om_doc_1",
                msg_type="text",
                create_time_ms=1_732_000_100_000,
                sender_open_id="ou_1",
                sender_type="user",
                deleted=False,
                content=json.dumps(
                    {"text": "接口规范在这里 https://team.feishu.cn/docx/DocToken123456"}
                ),
            ),
        ],
        resources={("om_file_1", "fk_notes"): b"# Weekly Sync\n- Discussed API"},
        docs={
            "DocToken123456": ("后端接口设计", "统一 REST API 规范与错误码。"),
            "TabDocToken789": ("测试验收清单", "覆盖全部 E2E 场景。"),
        },
        tabs=[
            {
                "tab_type": "doc",
                "tab_content": {"doc": "https://team.feishu.cn/docx/TabDocToken789"},
            }
        ],
    )

    first = sync_external_project_files(
        sync_db,
        leader,
        project.id,
        storage_client=storage_client,
        feishu_reader=feishu_reader,
    )
    assert first.github_synced == 1
    assert first.materials_synced == 1
    assert first.feishu_synced == 3
    assert first.warnings == []
    assert first.missing_feishu_scopes == []

    names = sorted(
        sync_db.scalars(select(LogicalFile.name).where(LogicalFile.project_id == project.id))
    )
    assert names == sorted(
        [
            "README.md",
            "四人分工计划.pdf",
            "周会纪要.md",
            "后端接口设计.md",
            "测试验收清单.md",
        ]
    )

    # 幂等重跑：内容未变，全部跳过，不重复追加版本
    replay = sync_external_project_files(
        sync_db,
        leader,
        project.id,
        storage_client=storage_client,
        feishu_reader=feishu_reader,
    )
    assert replay.github_synced == 0 and replay.github_skipped == 1
    assert replay.materials_synced == 0 and replay.materials_skipped == 1
    assert replay.feishu_synced == 0 and replay.feishu_skipped == 3

    # GitHub README 更新后，自动追加 v2 版本
    readme_v1.text = "# GroupProof\n\nUpdated README v2"
    sync_db.flush()
    updated = sync_external_project_files(
        sync_db,
        leader,
        project.id,
        storage_client=storage_client,
        feishu_reader=feishu_reader,
    )
    assert updated.github_synced == 1
    readme_row = sync_db.scalar(
        select(LogicalFile).where(
            LogicalFile.project_id == project.id, LogicalFile.name == "README.md"
        )
    )
    assert readme_row is not None and readme_row.latest_version_no == 2
    versions = list(
        sync_db.scalars(select(FileVersion).where(FileVersion.file_id == readme_row.id))
    )
    assert len(versions) == 2


def test_feishu_missing_scope_does_not_block_github_readme_sync(sync_db):
    leader, project = _seed_project(sync_db)
    storage_client = MemoryStorageClient()

    gh_link = GithubRepoLink(
        id=uuid4(),
        project_id=project.id,
        owner="ZZJ1977",
        repo="groupproof",
        installation_id=101,
        default_branch="main",
        linked_by_id=leader.id,
    )
    sync_db.add(gh_link)
    sync_db.flush()
    sync_db.add(
        GithubFile(
            id=uuid4(),
            project_id=project.id,
            link_id=gh_link.id,
            path="README.md",
            blob_sha="c" * 40,
            size_bytes=16,
            text="# README content",
        )
    )
    sync_db.add(
        FeishuChatLink(
            id=uuid4(),
            project_id=project.id,
            chat_id="oc_denied_chat",
            linked_by_id=leader.id,
        )
    )
    sync_db.flush()

    denied_reader = FakeFeishuReader(
        scope_error=feishu.FeishuScopeDeniedError(
            "飞书应用尚未开通群消息只读权限",
            missing_scopes=["im:message.history:readonly", "im:message:readonly"],
            auth_url="https://open.feishu.cn/app/cli_demo/auth?q=im:message.history:readonly",
        )
    )

    res = sync_external_project_files(
        sync_db,
        leader,
        project.id,
        storage_client=storage_client,
        feishu_reader=denied_reader,
    )
    assert res.github_synced == 1
    assert res.feishu_synced == 0
    assert "im:message.history:readonly" in res.missing_feishu_scopes
    assert res.feishu_auth_url == (
        "https://open.feishu.cn/app/cli_demo/auth?q=im:message.history:readonly"
    )
    assert len(res.warnings) == 1


def test_storage_unreachable_falls_back_to_db_snapshot_with_hmac_content(sync_db, monkeypatch):
    from urllib.parse import parse_qs, urlsplit

    from app.api.errors import ApiError
    from app.modules.c.external_files_sync import read_internal_file_content
    from app.modules.c.files_service import get_signed_link
    from app.modules.c.files_storage import UnavailableStoragePort

    monkeypatch.setenv("APP_ORIGIN", "https://staging.groupproof.example")
    monkeypatch.setenv("EMAIL_CHALLENGE_HMAC_KEY", "test-hmac-secret-key")

    leader, project = _seed_project(sync_db)
    gh_link = GithubRepoLink(
        id=uuid4(),
        project_id=project.id,
        owner="ZZJ1977",
        repo="groupproof",
        installation_id=101,
        default_branch="main",
        linked_by_id=leader.id,
    )
    sync_db.add(gh_link)
    sync_db.flush()
    sync_db.add(
        GithubFile(
            id=uuid4(),
            project_id=project.id,
            link_id=gh_link.id,
            path="README.md",
            blob_sha="d" * 40,
            size_bytes=22,
            text="# Live GitHub README\n",
        )
    )
    sync_db.flush()

    res = sync_external_project_files(
        sync_db,
        leader,
        project.id,
        storage_client=None,
    )
    assert res.github_synced == 1
    row = sync_db.scalar(
        select(LogicalFile).where(
            LogicalFile.project_id == project.id, LogicalFile.name == "README.md"
        )
    )
    assert row is not None
    ver = sync_db.scalar(select(FileVersion).where(FileVersion.file_id == row.id))
    assert ver is not None and ver.storage_provider == "github"

    signed = get_signed_link(
        sync_db, leader, project.id, row.id, ver.id, "preview", UnavailableStoragePort()
    )
    assert signed["url"].startswith("https://staging.groupproof.example/api/v1/projects/")
    qs = parse_qs(urlsplit(signed["url"]).query)
    data, media_type, filename = read_internal_file_content(
        sync_db,
        project.id,
        row.id,
        ver.id,
        purpose=qs["purpose"][0],
        exp=int(qs["exp"][0]),
        sig=qs["sig"][0],
    )
    assert data == b"# Live GitHub README\n"
    assert "text/markdown" in media_type
    assert filename == "README.md"

    with pytest.raises(ApiError) as tampered:
        read_internal_file_content(
            sync_db,
            project.id,
            row.id,
            ver.id,
            purpose="preview",
            exp=int(qs["exp"][0]),
            sig="0" * 64,
        )
    assert tampered.value.status_code == 403
