"""D4 binary export and report authorization regression checks."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from app.api.errors import ApiError
from app.modules.d import report_tasks, reporting
from app.modules.d.reporting import (
    _content_disposition,
    _deterministic_risk_explanation,
    _recover_stale_generating,
    _should_run_inline,
    render_document,
    require_editor,
)


def test_exports_are_real_pdf_docx_and_markdown_files():
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
            "overview": "任务完成 5 项\n成员协作正常\x00含控制字符",
            "risks": "存在一项风险",
            "appendix": "证据 A\n证据 B",
        },
        "evidence_records": [
            {"id": "ev-1", "task_id": "task-1", "title": "登录接口自动化验收报告\x0b"},
        ],
    }
    pdf, pdf_type = render_document(data, "pdf")
    docx, docx_type = render_document(data, "docx")
    md, md_type = render_document(data, "md")
    assert pdf.startswith(b"%PDF-") and len(pdf) > 500
    assert docx.startswith(b"PK") and len(docx) > 500
    assert pdf_type == "application/pdf"
    assert "wordprocessingml" in docx_type
    assert md_type == "text/markdown; charset=utf-8"
    md_text = md.decode("utf-8")
    assert "# GroupProof 跨模块全链路长标题测试项目" in md_text
    assert "| 任务完成 | 5 / 6 |" in md_text
    assert "登录接口自动化验收报告" in md_text
    assert "\x00" not in md_text

    import io

    from docx import Document as DocxReader

    parsed = DocxReader(io.BytesIO(docx))
    assert len(parsed.tables) == 2
    assert parsed.tables[0].cell(1, 2).text == "5"
    assert parsed.tables[1].cell(1, 0).text == "登录接口自动化验收报告"


def test_content_disposition_supports_utf8_and_ascii_fallback():
    header = _content_disposition("GroupProof 项目", 2, "pdf")
    assert 'filename="report-v2.pdf"' in header
    assert "filename*=UTF-8''" in header
    assert header.startswith("attachment;")


def test_should_run_inline_respects_env_monkeypatch_and_missing_worker(monkeypatch):
    monkeypatch.delenv("REPORT_INLINE_MODE", raising=False)
    reporting._worker_inspect_cache.clear()
    monkeypatch.setattr(reporting, "_has_registered_report_worker", lambda _name: False)
    assert _should_run_inline(
        report_tasks.generate_preview, "app.modules.d.report_tasks.generate_preview"
    )

    monkeypatch.setattr(reporting, "_has_registered_report_worker", lambda _name: True)
    assert not _should_run_inline(
        report_tasks.generate_preview, "app.modules.d.report_tasks.generate_preview"
    )

    # Monkeypatched .delay in unit tests must keep async dispatch semantics.
    monkeypatch.setattr(reporting, "_has_registered_report_worker", lambda _name: False)
    monkeypatch.setattr(report_tasks.generate_preview, "delay", lambda *_: None)
    assert not _should_run_inline(
        report_tasks.generate_preview, "app.modules.d.report_tasks.generate_preview"
    )

    monkeypatch.setenv("REPORT_INLINE_MODE", "true")
    assert _should_run_inline(
        report_tasks.generate_preview, "app.modules.d.report_tasks.generate_preview"
    )
    monkeypatch.setenv("REPORT_INLINE_MODE", "false")
    assert not _should_run_inline(
        report_tasks.generate_preview, "app.modules.d.report_tasks.generate_preview"
    )


def test_stale_generating_recovery_unblocks_orphaned_snapshots():
    report = SimpleNamespace(status="generating")
    fresh_snap = SimpleNamespace(status="generating", created_at=datetime.now(UTC))
    assert not _recover_stale_generating(report, [fresh_snap])
    assert report.status == "generating"

    stale_snap = SimpleNamespace(
        status="generating", created_at=datetime.now(UTC) - timedelta(minutes=5)
    )
    assert _recover_stale_generating(report, [stale_snap])
    assert report.status == "failed"
    assert stale_snap.status == "failed"


def test_deterministic_risk_explanation_covers_empty_and_active_risks():
    empty_text = _deterministic_risk_explanation(
        {"counts": {"tasks": 28, "completed_tasks": 28, "evidence": 114}}, []
    )
    assert "28/28" in empty_text
    assert "无活跃风险" in empty_text

    active_text = _deterministic_risk_explanation(
        {"counts": {"tasks": 10, "completed_tasks": 8, "evidence": 5}},
        [SimpleNamespace(title="接口延期", level="high")],
    )
    assert "接口延期" in active_text
    assert "高 1" in active_text


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
