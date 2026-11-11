"""A4-05 资料正文读取：格式支持、错误提示、截断，以及凭证读取的权限与指纹核对。"""

from __future__ import annotations

import hashlib
import io
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import a_fixtures as fixtures
import docx
import pytest
from pypdf import PdfWriter

from app.api.errors import ApiError
from app.modules.a import text_extraction as te
from app.modules.a.models import UploadReceipt as UploadReceiptRow

db = fixtures.db
scope = fixtures.scope


def _docx_bytes(*paragraphs: str, table: list[list[str]] | None = None) -> bytes:
    document = docx.Document()
    for text in paragraphs:
        document.add_paragraph(text)
    if table:
        t = document.add_table(rows=len(table), cols=len(table[0]))
        for r, row in enumerate(table):
            for c, value in enumerate(row):
                t.cell(r, c).text = value
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def _pdf_bytes(*, encrypted: bool = False) -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    if encrypted:
        writer.encrypt("secret")
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def test_markdown_and_text_are_read_as_utf8():
    md = te.extract_text("# 需求\r\n- 登录\r\n".encode(), "md")
    assert md.format == "md" and md.text == "# 需求\n- 登录"
    txt = te.extract_text("﻿第一行".encode(), "txt")
    assert txt.text == "第一行"


def test_non_utf8_text_is_rejected_not_guessed():
    with pytest.raises(ApiError) as exc:
        te.extract_text("需求".encode("gbk"), "txt")
    assert exc.value.code == "TEXT_DECODE_FAILED"


def test_docx_reads_paragraphs_and_tables():
    result = te.extract_text(
        _docx_bytes("项目目标", table=[["模块", "负责人"], ["登录", "张三"]]), "docx"
    )
    assert result.format == "docx"
    assert "项目目标" in result.text
    assert "模块\t负责人" in result.text and "登录\t张三" in result.text


def test_blank_pdf_is_empty_text_not_an_error():
    result = te.extract_text(_pdf_bytes(), "pdf")
    assert result.format == "pdf" and result.text == ""


def test_encrypted_and_corrupt_files_return_explicit_errors():
    with pytest.raises(ApiError) as exc:
        te.extract_text(_pdf_bytes(encrypted=True), "pdf")
    assert exc.value.code == "PDF_ENCRYPTED"

    with pytest.raises(ApiError) as exc:
        te.extract_text(b"not a pdf at all", "pdf")
    assert exc.value.code == "TEXT_EXTRACTION_FAILED"

    with pytest.raises(ApiError) as exc:
        te.extract_text(b"garbage", "docx")
    assert exc.value.code == "TEXT_EXTRACTION_FAILED"


def test_old_office_formats_are_unsupported_with_clear_message():
    for ext in ("doc", "ppt", "xls"):
        with pytest.raises(ApiError) as exc:
            te.extract_text(b"x", ext)
        assert exc.value.code == "TEXT_EXTRACTION_UNSUPPORTED"


def test_long_text_is_truncated_and_says_so():
    result = te.extract_text(("字" * (te.MAX_TEXT_CHARS + 10)).encode(), "txt")
    assert result.truncated is True
    assert result.char_count == te.MAX_TEXT_CHARS


class _Client:
    host = "demo.supabase.co"
    bucket = "groupproof-test"

    def __init__(self, objects):
        self.objects = objects

    def download(self, object_id, *, max_bytes):
        if object_id not in self.objects:
            raise FileNotFoundError(object_id)
        return self.objects[object_id]


def _receipt(db, scope, *, actor, data: bytes, filename="需求.md", tampered=False):
    object_id = f"obj-{uuid4().hex}"
    row = UploadReceiptRow(
        id=uuid4(),
        scope="project",
        scope_id=scope.project.id,
        actor_id=actor.id,
        provider="supabase",
        bucket="groupproof-test",
        object_id=object_id,
        filename=filename,
        declared_mime="text/markdown",
        declared_size=len(data),
        status="completed",
        content_hash=hashlib.sha256(data).hexdigest(),
        size_bytes=len(data),
        mime_type="text/markdown",
        created_at=datetime.now(UTC),
        upload_expires_at=datetime.now(UTC) + timedelta(hours=2),
        completed_at=datetime.now(UTC),
    )
    db.add(row)
    db.flush()
    stored = data + b"!" if tampered else data
    return row, _Client({object_id: stored})


def test_receipt_text_is_readable_by_uploader_member(db, scope):
    actor = scope.users["leader"]
    row, client = _receipt(db, scope, actor=actor, data="登录需求".encode())
    result = te.read_receipt_text(db, actor, row.id, client=client)
    assert result.text == "登录需求"


def test_receipt_text_refuses_other_users_and_tampered_content(db, scope):
    actor = scope.users["leader"]
    row, client = _receipt(db, scope, actor=actor, data=b"ok")
    with pytest.raises(ApiError) as exc:
        te.read_receipt_text(db, scope.users["member"], row.id, client=client)
    assert exc.value.status_code == 404

    row2, bad = _receipt(db, scope, actor=actor, data=b"ok", tampered=True)
    with pytest.raises(ApiError) as exc:
        te.read_receipt_text(db, actor, row2.id, client=bad)
    assert exc.value.code == "UPLOAD_CONTENT_MISMATCH"
