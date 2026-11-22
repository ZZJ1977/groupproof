"""D4 binary export and report authorization regression checks."""

from types import SimpleNamespace

import pytest

from app.api.errors import ApiError
from app.modules.d.reporting import render_document, require_editor


def test_exports_are_real_pdf_and_docx_files():
    data = {
        "project_name": "GroupProof 测试",
        "sections": {"overview": "任务完成 2 项", "risks": "存在一项风险"},
    }
    pdf, pdf_type = render_document(data, "pdf")
    docx, docx_type = render_document(data, "docx")
    assert pdf.startswith(b"%PDF-") and len(pdf) > 500
    assert docx.startswith(b"PK") and len(docx) > 500
    assert pdf_type == "application/pdf"
    assert "wordprocessingml" in docx_type
    assert "测试".encode() in docx or b"word/document.xml" in docx


def test_report_editor_requires_leader_or_teacher_and_active_project():
    active = SimpleNamespace(
        leader=True, teacher=False, project=SimpleNamespace(lifecycle="active")
    )
    require_editor(active)
    with pytest.raises(ApiError) as denied:
        require_editor(SimpleNamespace(leader=False, teacher=False, project=active.project))
    assert denied.value.status_code == 403
    with pytest.raises(ApiError) as archived:
        require_editor(
            SimpleNamespace(
                leader=True, teacher=False, project=SimpleNamespace(lifecycle="archived")
            )
        )
    assert archived.value.status_code == 403
