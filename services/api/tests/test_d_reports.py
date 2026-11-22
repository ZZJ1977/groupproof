"""D4 binary export and report authorization regression checks."""

from types import SimpleNamespace

import pytest

from app.api.errors import ApiError
from app.modules.d.reporting import render_document, require_editor


def test_exports_are_real_pdf_and_docx_files():
    data = {
        "project_name": "GroupProof 跨模块全链路长标题测试项目 — 验证不截断标题与表格结构",
        "counts": {
            "members": 4,
            "tasks": 6,
            "completed_tasks": 5,
            "evidence": 3,
            "risks": 1,
        },
        "sections": {
            "overview": "任务完成 5 项\n成员协作正常",
            "risks": "存在一项风险",
            "appendix": "证据 A\n证据 B",
        },
        "evidence_records": [
            {"id": "ev-1", "task_id": "task-1", "title": "登录接口自动化验收报告"},
        ],
    }
    pdf, pdf_type = render_document(data, "pdf")
    docx, docx_type = render_document(data, "docx")
    assert pdf.startswith(b"%PDF-") and len(pdf) > 500
    assert docx.startswith(b"PK") and len(docx) > 500
    assert pdf_type == "application/pdf"
    assert "wordprocessingml" in docx_type
    assert "测试".encode() in docx or b"word/document.xml" in docx

    import io

    from docx import Document as DocxReader

    parsed = DocxReader(io.BytesIO(docx))
    assert len(parsed.tables) == 2
    assert parsed.tables[0].cell(1, 2).text == "5"
    assert parsed.tables[1].cell(1, 0).text == "登录接口自动化验收报告"


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
