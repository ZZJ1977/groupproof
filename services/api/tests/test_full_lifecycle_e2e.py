"""End-to-end full-lifecycle verification across Modules A, B, C, and D.

Exercises the complete production chain over HTTP:
1. Admin bootstrap
2. Teacher creates class, publishes course material, rotates/reads invite code
3. Students join class via invite code, verify student material listing & download
4. Students form group & create course project
5. Inline Markdown material upload + automatic text extraction
6. Module & requirement creation -> checklist -> baseline submission, confirmation & freeze
   (verifying pinned course material version ref)
7. Task & criterion creation -> member confirmations -> plan freeze
8. Task start -> progress 100% (stays in_progress) -> task note + candidate evidence ->
   formal evidence designation -> integrity check -> enter verification -> auto verification ->
   human acceptance confirmation with 100% responsibility share -> task completed
9. Contribution calculation -> contribution freeze
10. Report preview generation -> real PDF & DOCX binary export & download -> submit ->
    teacher review approval (finalized)
11. Project leader archives project (verifying archived snapshot & pinned course files)
12. Global search RBAC verification across courses, projects, tasks, and evidence
"""

from __future__ import annotations

import base64
import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import JSON, DefaultClause, MetaData, create_engine, event, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapper, Session
from sqlalchemy.pool import StaticPool

from app.auth.services.bootstrap import bootstrap_admin
from app.db.base import Base
from tests.b_fixtures import _user, b_api, b_postgres_schema, b_test_database_url


@pytest.fixture
def e2e_engine(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("APP_MODE", "dev")
    monkeypatch.setenv("AI_PROVIDER", "fake")
    monkeypatch.setenv("TEACHER_EMAIL_DOMAIN", "must.edu.mo")
    if os.getenv("B_TEST_DATABASE_URL"):
        with b_postgres_schema(b_test_database_url()) as pg_engine:
            yield pg_engine
        return

    sqlite_engine = create_engine(
        "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )

    @event.listens_for(sqlite_engine, "connect")
    def enforce_fk(conn, _):
        conn.execute("PRAGMA foreign_keys=ON")
        conn.create_function("gen_random_uuid", 0, lambda: uuid4().hex)
        conn.create_function("to_regclass", 1, lambda _name: None)

    def ensure_tz(target, *_args):
        for key, val in list(vars(target).items()):
            if isinstance(val, datetime) and val.tzinfo is None:
                setattr(target, key, val.replace(tzinfo=UTC))

    event.listen(Mapper, "load", ensure_tz)
    event.listen(Mapper, "refresh", ensure_tz)

    metadata = MetaData()
    for table in Base.metadata.sorted_tables:
        portable = table.to_metadata(metadata)
        for column in portable.columns:
            if isinstance(column.type, JSONB):
                column.type = JSON()
            if (
                column.server_default is not None
                and str(column.server_default.arg) == "gen_random_uuid()"
            ):
                column.server_default = DefaultClause(text("(gen_random_uuid())"))
    metadata.create_all(sqlite_engine)
    try:
        yield sqlite_engine
    finally:
        event.remove(Mapper, "load", ensure_tz)
        event.remove(Mapper, "refresh", ensure_tz)
        sqlite_engine.dispose()


def test_complete_end_to_end_lifecycle(e2e_engine):
    now = datetime.now(UTC)
    tag = uuid4().hex[:6]
    with Session(e2e_engine) as session:
        admin = bootstrap_admin(
            session,
            name="平台管理员",
            username=f"admin_{tag}",
            school_email=f"admin_{tag}@must.edu.mo",
            password="Admin-Lifecycle-2026!",
        )
        teacher = _user(session, tag=f"t_{tag}", role="teacher", index=1, now=now)
        leader = _user(session, tag=f"s_{tag}", role="student", index=1, now=now)
        member = _user(session, tag=f"s_{tag}", role="student", index=2, now=now)
        admin_id, teacher_id, leader_id, member_id = admin.id, teacher.id, leader.id, member.id
        session.commit()

    with b_api(e2e_engine) as api:
        # 1. Teacher creates a class & publishes course rules + syllabus material
        deadline = (now + timedelta(days=30)).isoformat()
        created_class = api.as_user(teacher_id).post(
            "/api/v1/teacher/classes",
            {
                "code": f"SE{tag.upper()}",
                "name": "全链路软件工程实训",
                "semester": "2026 秋",
                "college": "计算机学院",
                "grouping_mode": "free",
                "min_group_size": 2,
                "max_group_size": 4,
                "project_deadline": deadline,
            },
        )
        assert created_class.status_code == 201, created_class.text
        course_data = created_class.json()["data"]
        course_id = course_data["id"]
        invite_code = course_data["invite_code"]
        assert invite_code

        # Publish course rules so students can create projects
        rules_res = api.as_user(teacher_id).get(f"/api/v1/teacher/classes/{course_id}/rules")
        assert rules_res.status_code == 200, rules_res.text
        pub_rules = api.as_user(teacher_id).post(
            f"/api/v1/teacher/classes/{course_id}/rules/publish",
            {"change_summary": "正式发布首版课程规则"},
        )
        assert pub_rules.status_code in (200, 201), pub_rules.text

        # Teacher uploads course syllabus in B teacher files center
        syllabus_bytes = "# 课程实训大纲\n1. 完成需求基线冻结\n2. 完成任务验收与结项报告".encode()
        uploaded_mat = api.as_user(teacher_id).post(
            f"/api/v1/teacher/classes/{course_id}/files/upload",
            {
                "name": "实训大纲-v1.md",
                "visibility": "all",
                "status": "published",
                "mime_type": "text/markdown",
                "size_bytes": len(syllabus_bytes),
                "content_base64": base64.b64encode(syllabus_bytes).decode(),
                "change_note": "首版教学大纲",
            },
        )
        assert uploaded_mat.status_code == 201, uploaded_mat.text
        syllabus_id = uploaded_mat.json()["data"]["item"]["id"]

        # 2. Both students join class via invite code & download teacher's syllabus
        for student_id in (leader_id, member_id):
            preview = api.as_user(student_id).post(
                "/api/v1/course-joins/preview", {"invite_code": invite_code}
            )
            assert preview.status_code == 200, preview.text
            joined = api.as_user(student_id).post(
                "/api/v1/course-joins", {"invite_code": invite_code}
            )
            assert joined.status_code == 201, joined.text
            assert joined.json()["data"]["status"] == "joined"

        student_mats = api.as_user(leader_id).get(f"/api/v1/courses/{course_id}/materials")
        assert student_mats.status_code == 200, student_mats.text
        assert [m["id"] for m in student_mats.json()["data"]["items"]] == [syllabus_id]
        dl_syllabus = api.as_user(leader_id).get(
            f"/api/v1/courses/{course_id}/materials/{syllabus_id}/download"
        )
        assert dl_syllabus.status_code == 200
        assert dl_syllabus.content == syllabus_bytes

        # 3. Form group & create project
        grp = api.as_user(leader_id).post(
            f"/api/v1/courses/{course_id}/groups",
            {"name": "第一实训小组", "direction": "全栈工程验证"},
        )
        assert grp.status_code == 201, grp.text
        group_id = grp.json()["data"]["id"]
        assert api.post_as(member_id, f"/api/v1/groups/{group_id}/join").status_code == 200

        proj = api.as_user(leader_id).post(
            f"/api/v1/groups/{group_id}/projects",
            {
                "name": "校园协作实证平台",
                "description": "端到端验证需求、任务、证据、贡献与结项归档全流程",
                "project_type": "Web 系统",
            },
        )
        assert proj.status_code == 201, proj.text
        project_id = proj.json()["data"]["project_id"]

        # 4. Inline Markdown material upload & automatic text extraction
        spec_md = "# 系统需求规格\n模块一：认证与权限控制，支持角色隔离与审计。\n".encode()
        mat_inline = api.as_user(leader_id).post(
            f"/api/v1/projects/{project_id}/materials/upload-inline",
            {
                "filename": "需求规格说明书.md",
                "mime_type": "text/markdown",
                "content_base64": base64.b64encode(spec_md).decode(),
            },
        )
        assert mat_inline.status_code == 201, mat_inline.text
        assert mat_inline.json()["data"]["extract_status"] == "ready"

        # 5. Create module + requirement, complete checklist, submit & freeze baseline
        mod = api.as_user(leader_id).post(
            f"/api/v1/projects/{project_id}/modules",
            {"name": "核心认证与证据模块", "owner_id": str(leader_id)},
        )
        assert mod.status_code == 201, mod.text
        module_id = mod.json()["data"]["id"]

        req = api.as_user(leader_id).post(
            f"/api/v1/projects/{project_id}/requirements",
            {
                "module_id": module_id,
                "title": "支持任务证据链与责任比例人工确认",
                "description": "每项验收标准须绑定正式证据并经人工确认承担比例",
                "priority": "high",
            },
        )
        assert req.status_code == 201, req.text
        req_id = req.json()["data"]["id"]

        chk0 = api.as_user(leader_id).get(f"/api/v1/projects/{project_id}/baseline/checklist")
        scope_ver = chk0.json()["data"]["scope_version"]
        assert (
            api.as_user(leader_id)
            .put(
                f"/api/v1/projects/{project_id}/baseline/scope",
                {
                    "in_scope": "核心认证、任务执行、证据采纳与结项报告",
                    "out_of_scope": "移动端原生客户端",
                    "expected_version": scope_ver,
                },
            )
            .status_code
            == 200
        )
        for item_key in ("requirements_reviewed", "sources_checked"):
            assert (
                api.as_user(leader_id)
                .put(
                    f"/api/v1/projects/{project_id}/baseline/checklist/{item_key}",
                    {"checked": True},
                )
                .status_code
                == 200
            )

        sub_base = api.as_user(leader_id).post(f"/api/v1/projects/{project_id}/baselines")
        assert sub_base.status_code == 201, sub_base.text
        baseline_id = sub_base.json()["data"]["id"]

        conf_base = api.as_user(member_id).put(
            f"/api/v1/projects/{project_id}/baselines/{baseline_id}/confirmations/{member_id}",
            {"decision": "confirm", "comment": "核对无误，同意冻结需求基线"},
        )
        assert conf_base.status_code == 200, conf_base.text
        frozen_base = conf_base.json()["data"]
        assert frozen_base["status"] == "frozen"
        pinned_files = frozen_base["snapshot"]["course_files"]
        assert any(
            f["file_id"] == syllabus_id and f["source"] == "b_material" and f["version_no"] == 1
            for f in pinned_files
        )

        # 6. Create task with weight=100, confirm by all members, freeze plan
        created_task = api.as_user(leader_id).post(
            f"/api/v1/projects/{project_id}/plan/tasks",
            {
                "title": "实现证据验收闭环",
                "module_id": module_id,
                "requirement_ids": [req_id],
                "assignee_ids": [str(leader_id)],
                "weight": 100,
                "criteria": [{"text": "提交候选证据并采纳为正式证据后通过人工确认"}],
            },
        )
        assert created_task.status_code == 201, created_task.text
        task_id = created_task.json()["data"]["id"]
        criterion_id = created_task.json()["data"]["criteria"][0]["id"]

        for uid in (leader_id, member_id):
            p_state = api.as_user(uid).get(f"/api/v1/projects/{project_id}/plan").json()["data"]
            c_res = api.as_user(uid).post(
                f"/api/v1/projects/{project_id}/plan/confirmations/me",
                {"task_versions": p_state["my_task_versions"]},
            )
            assert c_res.status_code == 200, c_res.text

        plan_ver = (
            api.as_user(leader_id)
            .get(f"/api/v1/projects/{project_id}/plan")
            .json()["data"]["lock_version"]
        )
        frz_plan = api.as_user(leader_id).post(
            f"/api/v1/projects/{project_id}/plan/freeze", {"expected_version": plan_ver}
        )
        assert frz_plan.status_code == 200, frz_plan.text
        assert frz_plan.json()["data"]["status"] == "frozen"

        # 7. C Task execution: start -> 100% progress -> note -> candidate -> formal evidence
        exec0 = api.as_user(leader_id).get(f"/api/v1/tasks/{task_id}/execution").json()["data"]
        st = api.as_user(leader_id).post(
            f"/api/v1/tasks/{task_id}/start", {"expected_version": exec0["version"]}
        )
        assert st.status_code == 200, st.text
        ver1 = st.json()["data"]["version"]

        prog = api.as_user(leader_id).patch(
            f"/api/v1/tasks/{task_id}/progress",
            {
                "progress": 100,
                "reason": "代码与自测全部完成，等待提交证据与人工验收",
                "expected_version": ver1,
            },
        )
        assert prog.status_code == 200, prog.text
        assert prog.json()["data"]["status"] == "in_progress"  # 100% never auto-completes!
        ver2 = prog.json()["data"]["version"]

        prep = api.as_user(leader_id).post(
            f"/api/v1/tasks/{task_id}/prepare-submission",
            {"expected_version": ver2},
        )
        assert prep.status_code == 200, prep.text
        assert prep.json()["data"]["execution"]["status"] == "pending_submission"

        note_res = api.as_user(leader_id).put(
            f"/api/v1/projects/{project_id}/tasks/{task_id}/note",
            {
                "expected_version": 0,
                "title": "证据采纳与验收联调说明",
                "body": "已完成证据采纳与验收接口联调说明。",
            },
        )
        assert note_res.status_code == 200, note_res.text
        note_ver_id = note_res.json()["data"]["versions"][0]["id"]

        cand_ev = api.as_user(leader_id).post(
            f"/api/v1/projects/{project_id}/evidence",
            {
                "task_id": task_id,
                "criterion_ids": [criterion_id],
                "title": "端到端联调验收记录",
                "description": "关联任务说明快照的候选证据",
                "source_type": "task_note",
                "source_id": str(note_ver_id),
            },
        )
        assert cand_ev.status_code == 201, cand_ev.text
        ev_data = cand_ev.json()["data"]
        evidence_id = ev_data["id"]
        assert ev_data["status"] == "candidate"

        desig = api.as_user(leader_id).post(
            f"/api/v1/projects/{project_id}/evidence/{evidence_id}/adopt",
            {"expected_version": ev_data["lock_version"], "reason": "核对任务说明与验收标准一致"},
        )
        assert desig.status_code == 200, desig.text
        assert desig.json()["data"]["status"] == "formal"

        # 8. D Integrity check -> Enter verification -> Auto verification -> Human confirmation
        ic = api.as_user(leader_id).post(
            f"/api/v1/projects/{project_id}/tasks/{task_id}/integrity-check"
        )
        assert ic.status_code == 200, ic.text
        assert ic.json()["data"]["coverage_rate"] == 100.0

        ev_enter = api.as_user(leader_id).post(
            f"/api/v1/projects/{project_id}/tasks/{task_id}/enter-verification"
        )
        assert ev_enter.status_code == 200, ev_enter.text
        assert ev_enter.json()["data"]["task"]["status"] == "pending_verification"

        v_run = api.as_user(leader_id).post(
            f"/api/v1/projects/{project_id}/tasks/{task_id}/verification"
        )
        assert v_run.status_code == 200, v_run.text
        # AI check alone never marks task completed
        exec_mid = api.as_user(leader_id).get(f"/api/v1/tasks/{task_id}/execution").json()["data"]
        assert exec_mid["status"] == "pending_verification"

        h_dec = api.as_user(leader_id).post(
            f"/api/v1/projects/{project_id}/tasks/{task_id}/verification/decision",
            {
                "decision": "confirmed",
                "reason": "人工逐项核验通过，确认实际承担比例",
                "responsibility_share": 100,
            },
        )
        assert h_dec.status_code == 200, h_dec.text
        assert h_dec.json()["data"]["status"] == "recorded"
        exec_done = api.as_user(leader_id).get(f"/api/v1/tasks/{task_id}/execution").json()["data"]
        assert exec_done["status"] == "completed"

        # 9. Contribution calculation & freeze
        calc = api.as_user(leader_id).post(f"/api/v1/projects/{project_id}/contribution/calculate")
        assert calc.status_code == 200, calc.text
        assert calc.json()["data"]["status"] == "draft"
        assert calc.json()["data"]["members"][0]["share"] == 100.0

        frz_contrib = api.as_user(leader_id).post(
            f"/api/v1/projects/{project_id}/contribution/freeze"
        )
        assert frz_contrib.status_code == 200, frz_contrib.text
        assert frz_contrib.json()["data"]["status"] == "frozen"

        # 10. Report generation -> real PDF & DOCX export -> submit -> teacher approve (finalize)
        rep_refresh = api.as_user(leader_id).post(
            f"/api/v1/projects/{project_id}/reports/refresh",
            {"includes_appendix": True},
        )
        assert rep_refresh.status_code in (200, 202), rep_refresh.text
        rep_state = (
            api.as_user(leader_id).get(f"/api/v1/projects/{project_id}/reports").json()["data"]
        )
        assert rep_state["status"] == "generated"
        assert rep_state["versions"][0]["status"] == "generated"
        assert rep_state["versions"][0]["data"]["counts"]["contribution_members"] == 1

        for fmt, magic in (("pdf", b"%PDF-"), ("docx", b"PK")):
            exp = api.as_user(leader_id).post(
                f"/api/v1/projects/{project_id}/reports/exports",
                {"version": 1, "file_format": fmt},
            )
            assert exp.status_code in (200, 202), exp.text
            art_id = exp.json()["data"]["id"]
            link_res = api.as_user(leader_id).post(
                f"/api/v1/projects/{project_id}/reports/exports/{art_id}/download-link"
            )
            assert link_res.status_code == 200, link_res.text
            dl_url = link_res.json()["data"]["url"]
            dl = api.as_user(leader_id).get(dl_url)
            assert dl.status_code == 200, dl.text
            assert dl.content.startswith(magic) and len(dl.content) > 500

        sub_rep = api.as_user(leader_id).post(f"/api/v1/projects/{project_id}/reports/submit")
        assert sub_rep.status_code == 200, sub_rep.text
        rep_after_sub = (
            api.as_user(leader_id).get(f"/api/v1/projects/{project_id}/reports").json()["data"]
        )
        assert rep_after_sub["status"] == "submitted"

        rev_rep = api.as_user(teacher_id).post(
            f"/api/v1/projects/{project_id}/reports/review",
            {"action": "approve", "reason": "证据链完整、贡献清晰，准予定稿结项"},
        )
        assert rev_rep.status_code == 200, rev_rep.text
        assert rev_rep.json()["data"]["status"] == "finalized"

        # 11. Project leader archives project
        archived = api.as_user(leader_id).post(f"/api/v1/projects/{project_id}/archive")
        assert archived.status_code == 200, archived.text
        arch_data = archived.json()["data"]
        assert arch_data["lifecycle"] == "archived"
        assert any(f["file_id"] == syllabus_id for f in arch_data["snapshot"]["course_files"])

        # 12. Global search RBAC: student finds project; admin sees zero project content
        s_student = api.as_user(leader_id).get("/api/v1/search?q=实证")
        assert s_student.status_code == 200
        kinds = {item["kind"] for item in s_student.json()["data"]["items"]}
        assert "project" in kinds

        s_admin = api.as_user(admin_id).get("/api/v1/search?q=实证")
        assert s_admin.status_code == 200
        admin_kinds = {item["kind"] for item in s_admin.json()["data"]["items"]}
        assert admin_kinds.isdisjoint({"project", "task", "evidence", "file"})
