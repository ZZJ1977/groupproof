"""B3-04 + A4-05 project material text extraction adapter and inline fallback tests."""

from __future__ import annotations

import base64
import hashlib
import io
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import docx
import pytest
import test_c_discussions as discussion_tests
from pypdf import PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from app.api.errors import ApiError
from app.modules.a.models import UploadReceipt as UploadReceiptRow
from app.modules.b import projects_service
from app.modules.b.material_text_port import PersistedMaterialTextPort
from app.modules.b.projects_schemas import UploadInlineMaterial

db = discussion_tests.db
scope = discussion_tests.scope


class _MemoryStorageClient:
    host = "storage.example.test"
    bucket = "test-bucket"

    def __init__(self, blobs: dict[str, bytes]) -> None:
        self._blobs = blobs

    def create_signed_upload_url(self, object_id: str) -> str:
        return f"https://{self.host}/upload/{object_id}"

    def download(self, object_id: str, *, max_bytes: int) -> bytes:
        if object_id not in self._blobs:
            raise FileNotFoundError(object_id)
        data = self._blobs[object_id]
        if len(data) > max_bytes:
            raise ValueError("too large")
        return data

    def create_signed_download_url(self, object_id: str, expires_in: int) -> str:
        return f"https://{self.host}/download/{object_id}?exp={expires_in}"


def _make_docx(paragraphs: list[str]) -> bytes:
    document = docx.Document()
    for para in paragraphs:
        document.add_paragraph(para)
    buf = io.BytesIO()
    document.save(buf)
    return buf.getvalue()


def _make_pdf(text: str, *, encrypted: bool = False) -> bytes:
    buf = io.BytesIO()
    pdf = canvas.Canvas(buf, pagesize=A4)
    pdf.drawString(50, 780, text)
    pdf.save()
    raw = buf.getvalue()
    if not encrypted:
        return raw
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(raw))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    writer.encrypt("secret")
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def test_persisted_material_text_port_extracts_paragraphs_and_enforces_ownership(db, scope):
    leader = scope.users["leader"]
    outsider = scope.users["outsider"]
    raw = "第一段：用户登录需求\n\n第二段：课程归档与权限校验".encode()
    receipt_id = uuid4()
    object_id = f"project/{scope.project.id}/{receipt_id}/spec.md"
    now = datetime.now(UTC)
    db.add(
        UploadReceiptRow(
            id=receipt_id,
            scope="project",
            scope_id=scope.project.id,
            actor_id=leader.id,
            provider="supabase",
            bucket="test-bucket",
            object_id=object_id,
            filename="spec.md",
            declared_mime="text/markdown",
            declared_size=len(raw),
            status="completed",
            content_hash=hashlib.sha256(raw).hexdigest(),
            size_bytes=len(raw),
            mime_type="text/markdown",
            scan_status="clean",
            created_at=now,
            upload_expires_at=now + timedelta(hours=1),
            completed_at=now,
        )
    )
    db.flush()

    port = PersistedMaterialTextPort(client=_MemoryStorageClient({object_id: raw}))
    material = port.get_text(db, receipt_id=receipt_id, actor_id=leader.id)
    assert material.status == "ready"
    assert len(material.segments) == 2
    assert "用户登录需求" in material.text
    assert "课程归档与权限校验" in material.text

    with pytest.raises(ApiError) as denied:
        port.get_text(db, receipt_id=receipt_id, actor_id=outsider.id)
    assert denied.value.status_code == 404


def test_inline_upload_extracts_md_docx_pdf_and_marks_encrypted_pdf_failed(db, scope):
    leader = scope.users["leader"]
    scope.project.setup_status = "draft"
    db.flush()

    # 1. Markdown inline extraction
    md_bytes = "# 项目需求说明书\n\n支持学生扫码签到与教师导出报表。".encode()
    md_dto = projects_service.upload_inline_material(
        db,
        leader,
        scope.project.id,
        UploadInlineMaterial(
            filename="requirements.md",
            mime_type="text/markdown",
            content_base64=base64.b64encode(md_bytes).decode("ascii"),
        ),
    )
    assert md_dto.extract_status == "ready"
    assert md_dto.text and "支持学生扫码签到" in md_dto.text

    # 2. DOCX inline extraction
    docx_bytes = _make_docx(["模块一：身份认证", "模块二：证据链核验"])
    docx_dto = projects_service.upload_inline_material(
        db,
        leader,
        scope.project.id,
        UploadInlineMaterial(
            filename="design.docx",
            mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            content_base64=base64.b64encode(docx_bytes).decode("ascii"),
        ),
    )
    assert docx_dto.extract_status == "ready"
    assert docx_dto.text and "模块一：身份认证" in docx_dto.text

    # 3. PDF with text layer
    pdf_bytes = _make_pdf("Milestone 1 Architecture Specification")
    pdf_dto = projects_service.upload_inline_material(
        db,
        leader,
        scope.project.id,
        UploadInlineMaterial(
            filename="architecture.pdf",
            mime_type="application/pdf",
            content_base64=base64.b64encode(pdf_bytes).decode("ascii"),
        ),
    )
    assert pdf_dto.extract_status == "ready"
    assert pdf_dto.text and "Milestone 1 Architecture Specification" in pdf_dto.text

    # 4. Encrypted PDF records failed status with explicit reason instead of fake text
    enc_pdf = _make_pdf("Secret", encrypted=True)
    enc_dto = projects_service.upload_inline_material(
        db,
        leader,
        scope.project.id,
        UploadInlineMaterial(
            filename="locked.pdf",
            mime_type="application/pdf",
            content_base64=base64.b64encode(enc_pdf).decode("ascii"),
        ),
    )
    assert enc_dto.extract_status == "failed"
    assert enc_dto.text is None
    assert enc_dto.extract_reason and "密码保护" in enc_dto.extract_reason


def test_persisted_material_text_port_returns_unavailable_without_content_hash(db, scope):
    leader = scope.users["leader"]
    receipt = UploadReceiptRow(
        id=uuid4(),
        scope="project",
        scope_id=scope.project.id,
        actor_id=leader.id,
        provider="local",
        bucket="test",
        object_id=f"obj-{uuid4().hex}",
        filename="需求说明.pdf",
        declared_mime="application/pdf",
        declared_size=100,
        status="completed",
        created_at=datetime.now(UTC),
        upload_expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    db.add(receipt)
    db.flush()

    port = PersistedMaterialTextPort(client=None)
    result = port.get_text(db, receipt_id=receipt.id, actor_id=leader.id)
    assert result.status == "unavailable"
    assert result.reason
