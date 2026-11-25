"""D4 report authoring, 7-chapter structure, AI rewrite, and rich export regression checks."""

import io
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from docx import Document as DocxReader

from app.api.errors import ApiError
from app.modules.d import report_tasks, reporting
from app.modules.d.reporting import (
    CHAPTER_ORDER,
    _content_disposition,
    _deterministic_risk_explanation,
    _ordered_section_entries,
    _parse_markdown_blocks,
    _recover_stale_generating,
    _should_run_inline,
    render_document,
    render_fallback_chapters,
    require_editor,
)


def _sample_facts() -> dict:
    return {
        "project": {
            "name": "GroupProof 协同平台",
            "description": "高校软件工程团队协作与贡献核算系统",
            "lifecycle": "active",
            "setup_status": "frozen",
            "final_deadline": "2026-12-01",
            "baseline_version": 2,
            "baseline_status": "frozen",
            "plan_version": 3,
            "plan_status": "frozen",
            "modules_count": 4,
            "requirements_count": 20,
            "requirements_high": 10,
        },
        "counts": {
            "members": 4,
            "tasks": 28,
            "completed_tasks": 28,
            "evidence": 114,
            "risks": 0,
            "contribution_members": 0,
        },
        "contribution_snapshot_id": None,
        "contribution_meta": {"is_frozen": False, "version": 4, "status": "draft"},
        "modules": [
            {
                "name": "模块 A：底座与认证",
                "owner": "卓子杰",
                "core": True,
                "requirements_count": 5,
                "tasks_total": 8,
                "tasks_completed": 8,
                "weight_sum": 30.0,
                "sample_tasks": ["A1 仓库基建", "A3 Google 认证"],
            }
        ],
        "milestones": [
            {
                "title": "第 1 周：底座搭通",
                "status": "completed",
                "status_label": "已完成",
                "deadline": "2026-10-18",
                "progress_percent": 100,
                "deliverables_done": 2,
                "deliverables_total": 2,
                "deliverable_titles": ["架构文档", "迁移脚本"],
                "linked_tasks_total": 4,
                "linked_tasks_completed": 4,
            }
        ],
        "tasks_brief": [
            {
                "title": "A1 仓库基建",
                "module": "模块 A：底座与认证",
                "status": "completed",
                "status_label": "已完成",
                "progress_percent": 100,
                "weight": 10.0,
                "assignees": ["卓子杰"],
            }
        ],
        "github": {
            "repo_count": 1,
            "commits": 142,
            "pull_requests": 18,
            "merged_prs": 18,
            "ci_runs": 24,
            "ci_success": 23,
            "additions": 48210,
            "deletions": 11230,
            "by_member": {
                "卓子杰": {"commits": 50, "prs": 6, "additions": 20000, "deletions": 4000}
            },
            "recent_highlights": [
                {
                    "kind": "commit",
                    "date": "2026-11-24",
                    "author": "卓子杰",
                    "title": "feat(reports): 7-chapter AI report",
                    "additions": 320,
                    "deletions": 40,
                }
            ],
        },
        "github_repos": [
            {
                "full_name": "org/groupproof",
                "default_branch": "develop",
                "last_synced_at": "2026-11-25",
            }
        ],
        "feishu": {
            "chat_count": 1,
            "total_messages": 420,
            "date_range": "2026-10-10 至 2026-11-24",
            "total_conclusions": 54,
            "overview": "四人按周同步推进并达成多项技术共识。",
            "categories": {
                "decision": 18,
                "task_progress": 20,
                "division_confirm": 8,
                "doc_review": 8,
            },
            "highlights": [
                {
                    "title": "四人分工计划已确认",
                    "category": "division_confirm",
                    "status": "completed",
                    "summary": "全体成员确认 A/B/C/D 四模块职责边界。",
                    "confirmed_count": 4,
                    "task_codes": ["T-001"],
                }
            ],
        },
        "evidence": {
            "total_formal": 114,
            "by_source": {"github": 80, "file": 20, "feishu": 14},
            "tasks_with_evidence": 28,
            "criteria_total": 84,
            "verification_runs": 32,
            "formal_outcomes": 28,
            "highlights": [{"title": "[abc123] 完成全链路验收", "source_type": "github"}],
        },
        "evidence_records": [
            {"id": "ev-1", "task_id": "task-1", "title": "登录接口自动化验收报告\x0b"},
        ],
        "members": [
            {
                "name": "卓子杰",
                "role": "组长",
                "github_login": "zzj1977",
                "share_percent": 30.0,
                "task_credit": 30.0,
                "tasks_assigned": 8,
                "tasks_completed": 8,
                "owned_modules": ["模块 A：底座与认证"],
                "github_commits": 50,
                "github_prs": 6,
                "github_additions": 20000,
                "github_deletions": 4000,
                "key_tasks": ["A1 仓库基建", "A3 Google 认证"],
            }
        ],
        "risks": {
            "active_count": 0,
            "closed_count": 2,
            "counts": {"total": 0, "high": 0, "medium": 0, "low": 0},
            "active": [],
            "closed": [],
        },
    }


def test_seven_ordered_chapters_and_rich_fallback_markdown_tables():
    facts = _sample_facts()
    chapters = render_fallback_chapters(facts)
    assert list(chapters.keys()) == CHAPTER_ORDER
    assert len(chapters) == 7
    # Ensure zero raw English placeholders and rich Chinese Markdown tables
    for key, content in chapters.items():
        assert len(content) > 60, f"chapter {key} too short"
        assert "0 active risks" not in content
        assert "No frozen contribution snapshot" not in content
    assert "| 里程碑阶段 | 截止日期 | 状态 | 进度 | 交付物 | 关联任务 |" in chapters["progress"]
    assert "| 第 1 周：底座搭通 | 2026-10-18 | 已完成 | 100% | 2/2 | 4/4 |" in chapters["progress"]
    assert "| 卓子杰 | 组长 | 30.0%" in chapters["contribution"]
    assert "四人分工计划已确认" in chapters["collaboration"]
    assert "无活跃未关闭风险" in chapters["reflection"]


def test_ordered_section_entries_preserves_chapter_order_against_jsonb_shuffle():
    facts = _sample_facts()
    chapters = render_fallback_chapters(facts)
    # Simulate Postgres JSONB scrambling dictionary keys (e.g. reflection/tasks first)
    scrambled = {
        "tasks": "legacy task line",
        "reflection": chapters["reflection"],
        "overview": chapters["overview"],
        "contribution": chapters["contribution"],
        "evidence": chapters["evidence"],
        "collaboration": chapters["collaboration"],
        "progress": chapters["progress"],
        "workflow": chapters["workflow"],
    }
    ordered = _ordered_section_entries(
        {"chapter_order": list(CHAPTER_ORDER), "sections": scrambled}
    )
    assert [key for key, _, _ in ordered] == CHAPTER_ORDER
    assert "tasks" not in [key for key, _, _ in ordered]


def test_exports_render_markdown_tables_to_real_pdf_docx_and_md():
    facts = _sample_facts()
    chapters = render_fallback_chapters(facts)
    chapters["overview"] += "\n含控制字符\x00测试"
    data = {
        "project_name": "GroupProof 跨模块全链路长标题测试项目 — 验证不截断标题与表格结构",
        "counts": facts["counts"],
        "chapter_order": list(CHAPTER_ORDER),
        "sections": {**chapters, "tasks": "legacy hidden task line"},
        "evidence_records": facts["evidence_records"],
    }
    pdf, pdf_type = render_document(data, "pdf")
    docx, docx_type = render_document(data, "docx")
    md, md_type = render_document(data, "md")

    assert pdf.startswith(b"%PDF-") and len(pdf) > 2000
    assert docx.startswith(b"PK") and len(docx) > 5000
    assert pdf_type == "application/pdf"
    assert "wordprocessingml" in docx_type
    assert md_type == "text/markdown; charset=utf-8"

    md_text = md.decode("utf-8")
    assert "## 一、项目概述与目标范围" in md_text
    assert "## 七、风险复盘与后续改进建议" in md_text
    assert "legacy hidden task line" not in md_text
    assert "\x00" not in md_text

    parsed = DocxReader(io.BytesIO(docx))
    # Summary table + multiple real GFM tables across the 7 chapters
    assert len(parsed.tables) >= 6
    assert parsed.tables[0].cell(1, 2).text == "28"


def test_markdown_block_parser_extracts_headings_tables_lists_and_quotes():
    sample = (
        "### 小节标题\n\n"
        "> 引用提示\n\n"
        "| 列A | 列B |\n"
        "| --- | ---: |\n"
        "| 值1 | **100%** |\n\n"
        "- 要点一\n"
        "- 要点二\n"
    )
    blocks = _parse_markdown_blocks(sample)
    assert [b["type"] for b in blocks] == ["heading", "quote", "table", "list"]
    assert blocks[2]["head"] == ["列A", "列B"]
    assert blocks[2]["rows"] == [["值1", "**100%**"]]


def test_ai_rewrite_helper_uses_openrouter_when_available(monkeypatch):
    facts = _sample_facts()
    monkeypatch.setattr(
        reporting,
        "_call_openrouter_json",
        lambda **kwargs: (
            {
                "content": (
                    "### 重写后的项目概述\n\n"
                    "**GroupProof** 已完成全部 28 项任务并沉淀 114 条正式证据。"
                )
            },
            "deepseek/deepseek-v3.2",
        ),
    )
    rewritten, model = reporting._rewrite_section_with_ai(
        facts,
        section_key="overview",
        current_body="旧内容",
        instruction="更精炼",
        actor_id=uuid4(),
        project_id=uuid4(),
    )
    assert model == "deepseek/deepseek-v3.2"
    assert rewritten is not None and "重写后的项目概述" in rewritten


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
