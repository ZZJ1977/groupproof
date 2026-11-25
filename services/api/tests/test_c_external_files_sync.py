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
    sync_db.add(
        FeishuChatLink(
            id=uuid4(),
            project_id=project.id,
            chat_id="oc_fallback_chat",
            linked_by_id=leader.id,
        )
    )
    sync_db.flush()

    feishu_reader = FakeFeishuReader(
        messages=[
            feishu.FeishuMessageItem(
                message_id="om_doc_fallback",
                msg_type="text",
                create_time_ms=1_732_000_200_000,
                sender_open_id="ou_1",
                sender_type="user",
                deleted=False,
                content=json.dumps({"text": "规范 https://team.feishu.cn/docx/FallbackDoc999"}),
            )
        ],
        docs={"FallbackDoc999": ("技术选型规范", "统一使用 FastAPI + Next.js。")},
    )

    res = sync_external_project_files(
        sync_db,
        leader,
        project.id,
        storage_client=None,
        feishu_reader=feishu_reader,
    )
    assert res.github_synced == 1
    assert res.feishu_synced == 1
    doc_row = sync_db.scalar(
        select(LogicalFile).where(
            LogicalFile.project_id == project.id, LogicalFile.name == "技术选型规范.md"
        )
    )
    assert doc_row is not None
    doc_ver = sync_db.scalar(select(FileVersion).where(FileVersion.file_id == doc_row.id))
    assert doc_ver is not None and doc_ver.storage_provider == "feishu_doc"
    doc_signed = get_signed_link(
        sync_db, leader, project.id, doc_row.id, doc_ver.id, "preview", UnavailableStoragePort()
    )
    doc_qs = parse_qs(urlsplit(doc_signed["url"]).query)
    doc_data, _, _ = read_internal_file_content(
        sync_db,
        project.id,
        doc_row.id,
        doc_ver.id,
        purpose=doc_qs["purpose"][0],
        exp=int(doc_qs["exp"][0]),
        sig=doc_qs["sig"][0],
    )
    assert "统一使用 FastAPI + Next.js" in doc_data.decode("utf-8")
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


def test_feishu_docx_blocks_render_rich_markdown_tables_code_and_images(sync_db, monkeypatch):
    from urllib.parse import parse_qs, urlsplit

    from app.modules.c.external_files_sync import (
        read_feishu_media,
        read_internal_file_content,
    )
    from app.modules.c.files_service import get_signed_link
    from app.modules.c.files_storage import UnavailableStoragePort

    monkeypatch.setenv("APP_ORIGIN", "https://staging.groupproof.example")
    monkeypatch.setenv("EMAIL_CHALLENGE_HMAC_KEY", "test-hmac-secret-key")

    leader, project = _seed_project(sync_db)
    sync_db.add(
        FeishuChatLink(
            id=uuid4(),
            project_id=project.id,
            chat_id="oc_rich_doc_chat",
            linked_by_id=leader.id,
        )
    )
    sync_db.flush()

    sample_blocks = [
        {
            "block_id": "doc_root",
            "block_type": 1,
            "children": [
                "h1_1",
                "p_1",
                "b_1",
                "o_1",
                "o_2",
                "t_1",
                "code_1",
                "callout_1",
                "div_1",
                "tbl_1",
                "sync_1",
                "img_1",
            ],
        },
        {
            "block_id": "h1_1",
            "block_type": 3,
            "heading1": {
                "elements": [{"text_run": {"content": "核心模块", "text_element_style": {}}}]
            },
        },
        {
            "block_id": "p_1",
            "block_type": 2,
            "text": {
                "elements": [
                    {"text_run": {"content": "支持 ", "text_element_style": {}}},
                    {"text_run": {"content": "加粗", "text_element_style": {"bold": True}}},
                    {"text_run": {"content": " 与 ", "text_element_style": {}}},
                    {
                        "text_run": {
                            "content": "pytest",
                            "text_element_style": {"inline_code": True},
                        }
                    },
                    {"text_run": {"content": " 及 ", "text_element_style": {}}},
                    {
                        "text_run": {
                            "content": "规范文档",
                            "text_element_style": {
                                "link": {"url": "https%3A%2F%2Fexample.com%2Fspec"}
                            },
                        }
                    },
                ]
            },
        },
        {
            "block_id": "b_1",
            "block_type": 12,
            "bullet": {
                "elements": [{"text_run": {"content": "一级要点", "text_element_style": {}}}]
            },
            "children": ["b_1_sub"],
        },
        {
            "block_id": "b_1_sub",
            "block_type": 12,
            "bullet": {"elements": [{"text_run": {"content": "子要点", "text_element_style": {}}}]},
        },
        {
            "block_id": "o_1",
            "block_type": 13,
            "ordered": {
                "elements": [{"text_run": {"content": "第一步", "text_element_style": {}}}]
            },
        },
        {
            "block_id": "o_2",
            "block_type": 13,
            "ordered": {
                "elements": [{"text_run": {"content": "第二步", "text_element_style": {}}}]
            },
        },
        {
            "block_id": "t_1",
            "block_type": 17,
            "todo": {
                "style": {"done": True},
                "elements": [{"text_run": {"content": "已完成检查", "text_element_style": {}}}],
            },
        },
        {
            "block_id": "code_1",
            "block_type": 14,
            "code": {
                "style": {"language": 49},
                "elements": [
                    {"text_run": {"content": "print('hello_world')", "text_element_style": {}}}
                ],
            },
        },
        {
            "block_id": "callout_1",
            "block_type": 19,
            "callout": {},
            "children": ["callout_p"],
        },
        {
            "block_id": "callout_p",
            "block_type": 2,
            "text": {"elements": [{"text_run": {"content": "重要提示", "text_element_style": {}}}]},
        },
        {"block_id": "div_1", "block_type": 22, "divider": {}},
        {
            "block_id": "tbl_1",
            "block_type": 31,
            "table": {
                "cells": ["c1", "c2", "c3", "c4"],
                "property": {"row_size": 2, "column_size": 2},
            },
            "children": ["c1", "c2", "c3", "c4"],
        },
        {"block_id": "c1", "block_type": 32, "children": ["c1_p"]},
        {"block_id": "c2", "block_type": 32, "children": ["c2_p"]},
        {"block_id": "c3", "block_type": 32, "children": ["c3_p"]},
        {"block_id": "c4", "block_type": 32, "children": ["c4_p"]},
        {
            "block_id": "c1_p",
            "block_type": 2,
            "text": {"elements": [{"text_run": {"content": "环节", "text_element_style": {}}}]},
        },
        {
            "block_id": "c2_p",
            "block_type": 2,
            "text": {"elements": [{"text_run": {"content": "负责人", "text_element_style": {}}}]},
        },
        {
            "block_id": "c3_p",
            "block_type": 2,
            "text": {"elements": [{"text_run": {"content": "A|B", "text_element_style": {}}}]},
        },
        {
            "block_id": "c4_p",
            "block_type": 2,
            "text": {"elements": [{"text_run": {"content": "组长", "text_element_style": {}}}]},
        },
        {
            "block_id": "sync_1",
            "block_type": 49,
            "source_synced": {},
            "children": ["sync_h2"],
        },
        {
            "block_id": "sync_h2",
            "block_type": 4,
            "heading2": {
                "elements": [{"text_run": {"content": "同步块内容", "text_element_style": {}}}]
            },
        },
        {
            "block_id": "img_1",
            "block_type": 27,
            "image": {"token": "ImgToken123456", "caption": {"content": "ER 架构图"}},
        },
    ]
    png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24

    class RichBlocksReader(FakeFeishuReader):
        def __init__(self, *, allow_media: bool = True) -> None:
            super().__init__(
                messages=[
                    feishu.FeishuMessageItem(
                        message_id="om_rich_1",
                        msg_type="text",
                        create_time_ms=1_732_000_500_000,
                        sender_open_id="ou_1",
                        sender_type="user",
                        deleted=False,
                        content=json.dumps({"text": "查看 https://team.feishu.cn/docx/RichDoc001"}),
                    )
                ],
                docs={"RichDoc001": ("架构设计", "fallback raw")},
            )
            self._allow_media = allow_media

        def get_docx_document_with_blocks(self, doc_token: str):
            assert doc_token == "RichDoc001"
            return "架构设计", sample_blocks

        def download_drive_media(self, file_token: str) -> tuple[bytes, str]:
            if not self._allow_media:
                raise feishu.FeishuScopeDeniedError(
                    "缺少云盘只读权限",
                    missing_scopes=["drive:drive:readonly"],
                    auth_url="https://open.feishu.cn/app/cli_demo/auth?q=drive:drive:readonly",
                )
            assert file_token == "ImgToken123456"
            return png_bytes, "application/octet-stream"

    res = sync_external_project_files(
        sync_db,
        leader,
        project.id,
        storage_client=None,
        feishu_reader=RichBlocksReader(allow_media=True),
    )
    assert res.feishu_synced == 1
    assert res.missing_feishu_scopes == []

    doc_row = sync_db.scalar(
        select(LogicalFile).where(
            LogicalFile.project_id == project.id, LogicalFile.name == "架构设计.md"
        )
    )
    assert doc_row is not None
    doc_ver = sync_db.scalar(select(FileVersion).where(FileVersion.file_id == doc_row.id))
    assert doc_ver is not None
    signed = get_signed_link(
        sync_db, leader, project.id, doc_row.id, doc_ver.id, "preview", UnavailableStoragePort()
    )
    qs = parse_qs(urlsplit(signed["url"]).query)
    data, media_type, _ = read_internal_file_content(
        sync_db,
        project.id,
        doc_row.id,
        doc_ver.id,
        purpose=qs["purpose"][0],
        exp=int(qs["exp"][0]),
        sig=qs["sig"][0],
    )
    md = data.decode("utf-8")
    assert "text/markdown" in media_type
    assert "# 核心模块" in md
    assert "**加粗**" in md and "`pytest`" in md and "[规范文档](https://example.com/spec)" in md
    assert "- 一级要点\n  - 子要点" in md
    assert "1. 第一步\n2. 第二步" in md
    assert "- [x] 已完成检查" in md
    assert "```python\nprint('hello_world')\n```" in md
    assert "> 重要提示" in md
    assert "---" in md
    assert "| 环节 | 负责人 |\n| --- | --- |\n| A\\|B | 组长 |" in md
    assert "## 同步块内容" in md
    assert f"![ER 架构图](/api/v1/projects/{project.id}/files/feishu-media/ImgToken123456)" in md

    # Media proxy verifies permissions & sniffs real PNG mime type
    img_bytes, img_mime = read_feishu_media(
        sync_db,
        leader,
        project.id,
        "ImgToken123456",
        feishu_reader=RichBlocksReader(allow_media=True),
    )
    assert img_bytes == png_bytes and img_mime == "image/png"

    # When drive:drive:readonly is missing, sync still succeeds and degrades image gracefully
    res_denied = sync_external_project_files(
        sync_db,
        leader,
        project.id,
        storage_client=None,
        feishu_reader=RichBlocksReader(allow_media=False),
    )
    assert res_denied.feishu_synced == 1
    assert "drive:drive:readonly" in res_denied.missing_feishu_scopes
    latest_ver = sync_db.scalar(
        select(FileVersion)
        .where(FileVersion.file_id == doc_row.id)
        .order_by(FileVersion.version_no.desc())
    )
    assert latest_ver is not None and latest_ver.version_no == 2
    signed_v2 = get_signed_link(
        sync_db, leader, project.id, doc_row.id, latest_ver.id, "preview", UnavailableStoragePort()
    )
    qs2 = parse_qs(urlsplit(signed_v2["url"]).query)
    md_v2 = read_internal_file_content(
        sync_db,
        project.id,
        doc_row.id,
        latest_ver.id,
        purpose=qs2["purpose"][0],
        exp=int(qs2["exp"][0]),
        sig=qs2["sig"][0],
    )[0].decode("utf-8")
    assert "在飞书云文档中查看原图" in md_v2
    assert "| 环节 | 负责人 |" in md_v2


def test_inline_pdf_resolves_binary_twin_and_falls_back_cleanly_when_alone(sync_db, monkeypatch):
    from urllib.parse import parse_qs, urlsplit

    from app.modules.c.external_files_sync import (
        probe_internal_file_media_type,
        read_internal_file_content,
    )
    from app.modules.c.files_service import get_signed_link
    from app.modules.c.files_storage import UnavailableStoragePort

    monkeypatch.setenv("APP_ORIGIN", "https://staging.groupproof.example")
    monkeypatch.setenv("EMAIL_CHALLENGE_HMAC_KEY", "test-hmac-secret-key")

    leader, project = _seed_project(sync_db)
    now = datetime.now(UTC)
    pdf_bytes = b"%PDF-1.4\n%real binary pdf content\n%%EOF"
    pdf_hash = hashlib.sha256(pdf_bytes).hexdigest()

    # Create an inline PDF (text-only material) that shares the exact hash with a feishu_att PDF
    inline_receipt = UploadReceipt(
        id=uuid4(),
        scope="project",
        scope_id=project.id,
        actor_id=leader.id,
        provider="inline",
        bucket="inline-materials",
        object_id=f"project/{project.id}/inline/plan.pdf",
        filename="分工计划_inline.pdf",
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
    sync_db.add(inline_receipt)
    sync_db.flush()
    sync_db.add(
        BProjectMaterial(
            id=uuid4(),
            project_id=project.id,
            kind="file",
            title="分工计划_inline.pdf",
            receipt_id=inline_receipt.id,
            extract_status="ready",
            text_content="Page 1 of 25 extracted plain text",
            created_by=leader.id,
        )
    )
    # Register inline PDF directly (simulating pre-existing staging row)
    inline_lf = LogicalFile(
        id=uuid4(),
        project_id=project.id,
        name="分工计划_inline.pdf",
        name_key="分工计划_inline.pdf".casefold(),
        category="documents",
        latest_version_no=1,
        created_by=leader.id,
    )
    sync_db.add(inline_lf)
    sync_db.flush()
    inline_ver = FileVersion(
        id=uuid4(),
        file_id=inline_lf.id,
        version_no=1,
        receipt_id=inline_receipt.id,
        storage_provider="inline",
        storage_object_id=inline_receipt.object_id,
        storage_revision=inline_receipt.revision,
        content_hash=pdf_hash,
        original_name="分工计划_inline.pdf",
        extension="pdf",
        mime_type="application/pdf",
        size_bytes=len(pdf_bytes),
        uploaded_by=leader.id,
    )
    sync_db.add(inline_ver)
    sync_db.flush()

    # 1) Without a binary twin, probe reports text/plain and content serves extracted text
    signed = get_signed_link(
        sync_db,
        leader,
        project.id,
        inline_lf.id,
        inline_ver.id,
        "preview",
        UnavailableStoragePort(),
    )
    qs = parse_qs(urlsplit(signed["url"]).query)
    probed_mime, probed_name = probe_internal_file_media_type(
        sync_db,
        project.id,
        inline_lf.id,
        inline_ver.id,
        purpose="preview",
        exp=int(qs["exp"][0]),
        sig=qs["sig"][0],
    )
    assert probed_mime.startswith("text/plain") and probed_name.endswith(".txt")
    fallback_bytes, fallback_mime, _ = read_internal_file_content(
        sync_db,
        project.id,
        inline_lf.id,
        inline_ver.id,
        purpose="preview",
        exp=int(qs["exp"][0]),
        sig=qs["sig"][0],
    )
    assert fallback_mime.startswith("text/plain")
    assert b"Page 1 of 25" in fallback_bytes

    # 2) Once a feishu_att twin with the same hash exists, probe & read serve real PDF!
    att_receipt = UploadReceipt(
        id=uuid4(),
        scope="project",
        scope_id=project.id,
        actor_id=leader.id,
        provider="feishu_att",
        bucket="feishu-attachments",
        object_id="feishu-att/om_pdf_1/fk_pdf_1",
        filename="分工计划.pdf",
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
    sync_db.add(att_receipt)
    sync_db.flush()
    att_lf = LogicalFile(
        id=uuid4(),
        project_id=project.id,
        name="分工计划.pdf",
        name_key="分工计划.pdf".casefold(),
        category="documents",
        latest_version_no=1,
        created_by=leader.id,
    )
    sync_db.add(att_lf)
    sync_db.flush()
    sync_db.add(
        FileVersion(
            id=uuid4(),
            file_id=att_lf.id,
            version_no=1,
            receipt_id=att_receipt.id,
            storage_provider="feishu_att",
            storage_object_id=att_receipt.object_id,
            storage_revision=att_receipt.revision,
            content_hash=pdf_hash,
            original_name="分工计划.pdf",
            extension="pdf",
            mime_type="application/pdf",
            size_bytes=len(pdf_bytes),
            uploaded_by=leader.id,
        )
    )
    sync_db.flush()

    probed_mime2, probed_name2 = probe_internal_file_media_type(
        sync_db,
        project.id,
        inline_lf.id,
        inline_ver.id,
        purpose="preview",
        exp=int(qs["exp"][0]),
        sig=qs["sig"][0],
    )
    assert probed_mime2 == "application/pdf" and probed_name2 == "分工计划_inline.pdf"
    real_bytes, real_mime, real_name = read_internal_file_content(
        sync_db,
        project.id,
        inline_lf.id,
        inline_ver.id,
        purpose="preview",
        exp=int(qs["exp"][0]),
        sig=qs["sig"][0],
        feishu_reader=FakeFeishuReader(resources={("om_pdf_1", "fk_pdf_1"): pdf_bytes}),
    )
    assert real_bytes == pdf_bytes
    assert real_mime == "application/pdf"
    assert real_name == "分工计划_inline.pdf"
