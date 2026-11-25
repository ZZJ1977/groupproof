"""D4 report authoring, 7-chapter structure, AI rewrite, and rich export regression checks."""

import io
import zipfile
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from docx import Document as DocxReader
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image as PILImage

from app.api.auth import get_current_user
from app.api.errors import ApiError, install_exception_handlers
from app.db.session import get_session
from app.modules.d import report_charts, report_tasks, reporting
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
    facts["project"]["course_name"] = "软件工程综合实践"
    facts["project"]["semester"] = "2026 秋季"
    facts["feishu"]["blockers"] = [
        {
            "title": "CI 环境依赖版本冲突排查",
            "category": "blocker",
            "status": "completed",
            "summary": "排查锁定 Alembic 迁移与 Python 依赖版本，修复构建失败。",
            "confirmed_count": 3,
            "task_codes": ["T-008"],
        }
    ]
    chapters = render_fallback_chapters(facts)
    assert list(chapters.keys()) == CHAPTER_ORDER
    assert len(chapters) == 7
    # Ensure substantive publication-grade prose + tables (never 1-sentence stubs)
    total_chars = sum(len(content) for content in chapters.values())
    assert total_chars >= 2000, f"fallback report too thin: {total_chars} chars"
    for key, content in chapters.items():
        assert len(content) > 220, f"chapter {key} too short ({len(content)} chars)"
        assert "0 active risks" not in content
        assert "No frozen contribution snapshot" not in content
    assert "| 里程碑阶段 | 截止日期 | 状态 | 进度 | 交付物 | 关联任务 |" in chapters["progress"]
    assert "| 第 1 周：底座搭通 | 2026-10-18 | 已完成 | 100% | 2/2 | 4/4 |" in chapters["progress"]
    assert "| 卓子杰 | 组长 | 30.0%" in chapters["contribution"]
    # Chapter 6 must NOT open with an ugly internal draft warning; footnote belongs at bottom
    assert not chapters["contribution"].startswith("当前尚未冻结")
    assert "当前基于最新贡献快照 v4 编制" in chapters["contribution"].splitlines()[-1]
    assert "四人分工计划已确认" in chapters["collaboration"]
    assert "无活跃未关闭风险" in chapters["reflection"]
    assert "CI 环境依赖版本冲突排查" in chapters["reflection"]


def test_extract_json_object_and_two_batch_ai_authoring_partial_resilience(monkeypatch):
    parsed = reporting._extract_json_object(
        '以下是结果：\n```json\n{"overview": "完整正文内容"}\n```\n请查收'
    )
    assert parsed == {"overview": "完整正文内容"}
    assert (
        reporting._strip_leading_chapter_heading(
            "## 一、项目概述与目标范围\n\n正文开始", "overview"
        )
        == "正文开始"
    )

    facts = _sample_facts()
    seen_features: list[str] = []
    seen_max_tokens: list[int] = []

    def fake_openrouter(**kwargs):
        seen_features.append(kwargs["feature"])
        seen_max_tokens.append(kwargs["max_tokens"])
        if kwargs["feature"] == "generate_project_report_part1":
            long_body = (
                "### 真实核验\n\n"
                + "项目按周持续推进，完成全部核心模块交付并沉淀可核验工程证据。" * 4
            )
            return (
                {
                    "overview": f"## 一、项目概述与目标范围\n\n{long_body}",
                    "workflow": long_body,
                    "progress": long_body,
                    "collaboration": "太短",  # should be skipped so fallback fills it
                },
                "deepseek/deepseek-v3.2",
            )
        # Simulate batch 2 partial failure (returns None) — batch 1 chapters must still survive!
        return None, "deepseek/deepseek-v3.2"

    monkeypatch.setattr(reporting, "_call_openrouter_json", fake_openrouter)
    authored, model = reporting._author_report_with_ai(facts, actor_id=uuid4(), project_id=uuid4())
    assert model == "deepseek/deepseek-v3.2"
    assert set(seen_features) == {"generate_project_report_part1", "generate_project_report_part2"}
    assert all(mt >= 4000 for mt in seen_max_tokens)
    assert authored is not None
    assert set(authored.keys()) == {"overview", "workflow", "progress"}
    assert not authored["overview"].startswith("## 一、")


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


def test_all_five_default_charts_render_valid_high_dpi_cjk_pngs():
    facts = _sample_facts()
    specs = report_charts.build_default_visual_specs(facts)
    assert [s["id"] for s in specs] == [
        "architecture",
        "workflow",
        "milestones",
        "evidence",
        "contribution",
    ]
    for spec in specs:
        png = report_charts.render_visual_spec(spec, facts)
        assert png.startswith(b"\x89PNG\r\n\x1a\n")
        assert len(png) > 5000, f"chart {spec['id']} unexpectedly small ({len(png)} bytes)"
        with PILImage.open(io.BytesIO(png)) as img:
            w, h = img.size
            assert w == report_charts.CANVAS_WIDTH
            assert h >= 450


def test_ai_custom_visual_specs_sanitization_and_arbitrary_slug_rendering():
    facts = _sample_facts()
    raw_visuals = [
        {
            "id": "Proposal-Arch!",
            "section_key": "overview",
            "template": "layered_architecture",
            "badge": "总体架构",
            "title": "智能课程协作系统三层架构",
            "subtitle": "依据项目提案动态绘制",
            "caption": "智能课程协作系统架构总览",
            "payload": {
                "layers": [
                    {
                        "name": "终端与前端层",
                        "accent": "sky",
                        "nodes": [{"title": "Web 协作端", "subtitle": "Next.js App Router"}],
                    },
                    {
                        "name": "业务与 AI 服务层",
                        "accent": "emerald",
                        "nodes": [
                            {
                                "title": "模块 A：底座与认证",
                                "subtitle": "负责人：卓子杰",
                                "metric": "8/8 任务",
                                "progress": 100,
                            }
                        ],
                    },
                ]
            },
        },
        {
            "id": "sprint_loop",
            "section_key": "workflow",
            "template": "process_flow",
            "badge": "迭代闭环",
            "title": "四周敏捷迭代与验证流水线",
            "caption": "图 99：四周敏捷迭代与验证流水线",
            "payload": {
                "steps": [
                    {"step": "01", "title": "需求对齐", "metric": "20 条", "detail": "冻结基线"},
                    {"step": "02", "title": "并行开发", "metric": "142 提交", "detail": "PR 评审"},
                    {"step": "03", "title": "自动验收", "metric": "114 证据", "detail": "人工确认"},
                ]
            },
        },
        {
            "id": "invalid_tpl",
            "section_key": "progress",
            "template": "unsupported_3d_pie",
            "title": "Should be dropped",
            "payload": {},
        },
        {
            "id": "invalid_sec",
            "section_key": "unknown_chapter",
            "template": "process_flow",
            "title": "Should also be dropped",
            "payload": {},
        },
    ]

    cleaned = report_charts.sanitize_visual_specs(raw_visuals, facts)
    assert len(cleaned) == 2
    assert [sp["id"] for sp in cleaned] == ["proposal-arch", "sprint_loop"]
    assert cleaned[0]["caption"] == "图 1：智能课程协作系统架构总览"
    assert cleaned[1]["caption"] == "图 2：四周敏捷迭代与验证流水线"

    snapshot = {"visuals": cleaned, "facts": facts}
    for sp in cleaned:
        png = report_charts.render_chart_from_snapshot(snapshot, sp["id"])
        assert png is not None and png.startswith(b"\x89PNG\r\n\x1a\n") and len(png) > 5000
    assert report_charts.render_chart_from_snapshot(snapshot, "../bad") is None
    assert report_charts.render_chart_from_snapshot(snapshot, "unknown_slug") is None


def test_plan_report_visuals_with_ai_and_chapter_injection_preserves_footnotes(monkeypatch):
    facts = _sample_facts()
    project_id = uuid4()

    def fake_openrouter(**kwargs):
        assert kwargs["feature"] == "plan_report_visuals"
        return (
            {
                "visuals": [
                    {
                        "id": "domain_arch",
                        "section_key": "overview",
                        "template": "layered_architecture",
                        "title": "项目领域分层架构",
                        "caption": "项目领域分层架构",
                        "payload": {},
                    },
                    {
                        "id": "member_matrix",
                        "section_key": "contribution",
                        "template": "member_comparison",
                        "title": "团队贡献多维矩阵",
                        "caption": "团队贡献多维矩阵",
                        "payload": {},
                    },
                ]
            },
            "deepseek/deepseek-v3.2",
        )

    monkeypatch.setattr(reporting, "_call_openrouter_json", fake_openrouter)
    visuals, model = reporting._plan_report_visuals_with_ai(
        facts, actor_id=uuid4(), project_id=project_id
    )
    assert model == "deepseek/deepseek-v3.2"
    assert visuals is not None and len(visuals) == 2

    chapters = render_fallback_chapters(facts, project_id=project_id, version_no=2, visuals=visuals)
    expected_arch_url = f"/api/v1/projects/{project_id}/reports/versions/2/charts/domain_arch.png"
    expected_contrib_url = (
        f"/api/v1/projects/{project_id}/reports/versions/2/charts/member_matrix.png"
    )
    assert f"![图 1：项目领域分层架构]({expected_arch_url})" in chapters["overview"]
    assert f"![图 2：团队贡献多维矩阵]({expected_contrib_url})" in chapters["contribution"]
    # Footnote must remain at the bottom of Chapter 6
    assert "当前基于最新贡献快照 v4 编制" in chapters["contribution"].splitlines()[-1]

    # Re-injecting must be idempotent (no duplicate image lines)
    re_injected = reporting._inject_visuals_into_chapters(
        chapters, visuals, project_id=project_id, version_no=2
    )
    assert re_injected["overview"].count(expected_arch_url) == 1

    # Rewriting version URLs updates v2 -> v3 cleanly
    bumped = reporting._rewrite_chart_version_urls(chapters, 3)
    assert "/versions/3/charts/domain_arch.png" in bumped["overview"]
    assert "/versions/2/charts/domain_arch.png" not in bumped["overview"]


def test_pdf_and_docx_exports_embed_real_png_charts():
    facts = _sample_facts()
    project_id = uuid4()
    visuals = report_charts.build_default_visual_specs(facts)
    chapters = render_fallback_chapters(facts, project_id=project_id, version_no=1, visuals=visuals)
    data = {
        "project_name": facts["project"]["name"],
        "counts": facts["counts"],
        "chapter_order": list(CHAPTER_ORDER),
        "sections": chapters,
        "visuals": visuals,
        "facts": reporting._snapshot_chart_facts(facts),
        "evidence_records": facts["evidence_records"],
    }

    blocks = _parse_markdown_blocks(chapters["overview"])
    img_blocks = [b for b in blocks if b["type"] == "image"]
    assert len(img_blocks) == 1
    assert img_blocks[0]["alt"] == "图 1：系统架构与模块分工总览图"

    pdf_bytes, pdf_mime = render_document(data, "pdf")
    docx_bytes, docx_mime = render_document(data, "docx")
    md_bytes, md_mime = render_document(data, "md")

    assert pdf_mime == "application/pdf"
    assert pdf_bytes.startswith(b"%PDF-") and len(pdf_bytes) > 50000
    assert b"/Subtype /Image" in pdf_bytes

    assert "wordprocessingml" in docx_mime
    assert docx_bytes.startswith(b"PK") and len(docx_bytes) > 50000
    with zipfile.ZipFile(io.BytesIO(docx_bytes)) as zf:
        media_pngs = [
            name
            for name in zf.namelist()
            if name.startswith("word/media/") and name.endswith(".png")
        ]
        assert len(media_pngs) == 5
        for media_name in media_pngs:
            raw_img = zf.read(media_name)
            assert raw_img.startswith(b"\x89PNG\r\n\x1a\n") and len(raw_img) > 5000

    assert md_mime == "text/markdown; charset=utf-8"
    md_text = md_bytes.decode("utf-8")
    expected_md_img = (
        f"![图 1：系统架构与模块分工总览图]"
        f"(/api/v1/projects/{project_id}/reports/versions/1/charts/architecture.png)"
    )
    assert expected_md_img in md_text


def test_report_chart_http_endpoint_returns_png_and_enforces_validation(monkeypatch):
    project_id = uuid4()
    report_id = uuid4()
    facts = _sample_facts()
    visuals = report_charts.build_default_visual_specs(facts)
    custom_spec = {
        **visuals[0],
        "id": "custom_proposal_map",
        "title": "自定义提案架构图",
        "caption": "图 1：自定义提案架构图",
    }
    snap_obj = SimpleNamespace(
        id=uuid4(),
        report_id=report_id,
        version_no=2,
        status="generated",
        data_snapshot={
            "project_name": facts["project"]["name"],
            "visuals": [custom_spec, *visuals[1:]],
            "facts": reporting._snapshot_chart_facts(facts),
        },
    )
    report_obj = SimpleNamespace(id=report_id, project_id=project_id)

    class FakeSession:
        def __init__(self):
            self.calls = 0

        def scalar(self, _stmt):
            self.calls += 1
            return report_obj if self.calls == 1 else snap_obj

    app = FastAPI()

    @app.middleware("http")
    async def attach_request_id(request, call_next):
        request.state.request_id = "test-req-id"
        return await call_next(request)

    install_exception_handlers(app)
    app.include_router(reporting.router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=uuid4(), name="测试员")
    app.dependency_overrides[get_session] = lambda: FakeSession()

    monkeypatch.setattr(
        reporting,
        "get_project_access",
        lambda *_a, **_k: SimpleNamespace(project=SimpleNamespace(name=facts["project"]["name"])),
    )

    client = TestClient(app)

    # Custom AI-authored visual slug works
    res_custom = client.get(
        f"/api/v1/projects/{project_id}/reports/versions/2/charts/custom_proposal_map.png"
    )
    assert res_custom.status_code == 200
    assert res_custom.headers["content-type"] == "image/png"
    assert res_custom.headers["x-content-type-options"] == "nosniff"
    assert "max-age=300" in res_custom.headers["cache-control"]
    assert res_custom.content.startswith(b"\x89PNG\r\n\x1a\n") and len(res_custom.content) > 5000

    # Built-in default key also works
    res_wf = client.get(f"/api/v1/projects/{project_id}/reports/versions/2/charts/workflow.png")
    assert res_wf.status_code == 200
    assert res_wf.content.startswith(b"\x89PNG\r\n\x1a\n") and len(res_wf.content) > 5000

    # Unknown chart key returns 404
    res_missing = client.get(
        f"/api/v1/projects/{project_id}/reports/versions/2/charts/does_not_exist.png"
    )
    assert res_missing.status_code == 404

    # Invalid slug returns 404
    res_bad = client.get(
        f"/api/v1/projects/{project_id}/reports/versions/2/charts/INVALID%20KEY.png"
    )
    assert res_bad.status_code == 404
