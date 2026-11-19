"""Teacher class creation, roster sidebar, team plaza, and milestone progress tests."""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier
from uuid import UUID, uuid4

import pytest
from sqlalchemy import JSON, DefaultClause, MetaData, create_engine, event, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapper, Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import (
    Course,
    CourseStaff,
    FunctionalModule,
    Milestone,
    ProjectGroup,
    ProjectMember,
    Task,
    TaskMilestone,
)
from app.modules.a.models import AuditEvent
from app.modules.c.governance_models import (
    CourseCodeRegistry,
    CourseInvite,
    CourseLifecycleDecision,
)
from tests.b_fixtures import (
    _user,
    add_course_student,
    add_student,
    b_api,
    b_postgres_schema,
    b_test_database_url,
    build_b_world,
)


@pytest.fixture
def b_engine(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    if os.getenv("B_TEST_DATABASE_URL"):
        with b_postgres_schema(b_test_database_url()) as engine:
            yield engine
        return
    engine = create_engine(
        "sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False}
    )

    @event.listens_for(engine, "connect")
    def enforce_foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
        connection.create_function("gen_random_uuid", 0, lambda: uuid4().hex)
        connection.create_function("to_regclass", 1, lambda _name: None)

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
    metadata.create_all(engine)
    try:
        yield engine
    finally:
        event.remove(Mapper, "load", ensure_tz)
        event.remove(Mapper, "refresh", ensure_tz)
        engine.dispose()


@pytest.fixture
def setup(b_engine):
    with Session(b_engine) as session:
        world = build_b_world(session, max_group_size=3)
        other = build_b_world(session)
        loose = [add_course_student(session, world) for _ in range(4)]
        unverified_teacher = _user(
            session,
            tag=uuid4().hex[:8],
            role="teacher",
            index=9,
            now=datetime.now(UTC),
            verified=False,
        )
        ta = _user(
            session,
            tag=uuid4().hex[:8],
            role="ta",
            index=1,
            now=datetime.now(UTC),
            verified=True,
        )
        session.add(CourseStaff(course_id=world.course_id, user_id=ta.id, role="ta"))
        session.commit()
        unverified_teacher_id = unverified_teacher.id
        ta_id = ta.id
    with b_api(b_engine) as api:
        yield api, world, other, loose, unverified_teacher_id, ta_id


def test_t1_t2_t3_t4_teacher_creates_class_student_joins_and_invite_rotates(setup, b_engine):
    api, world, _other, _loose, unverified_teacher_id, _ta_id = setup
    future = (datetime.now(UTC) + timedelta(days=60)).isoformat()

    # T1: Verified teacher creates class with blank code -> auto CLS-XXXXXX, 32-char invite code
    api.as_user(world.teacher_id)
    res = api.post(
        "/api/v1/teacher/classes",
        json={
            "name": "软件工程实践 01 班",
            "semester": "2026-Autumn",
            "college": "计算机学院",
            "project_deadline": future,
            "min_group_size": 1,
            "max_group_size": 5,
            "join_mode": "approval",
        },
    )
    assert res.status_code == 201, res.text
    created = res.json()["data"]
    cid = UUID(created["id"])
    assert created["code"].startswith("CLS-") and len(created["code"]) == 10
    assert created["status"] == "active"
    assert created["invite_code"] and len(created["invite_code"]) >= 20
    assert created["join_url"] == f"/courses/join?code={created['invite_code']}"
    assert created["join_mode"] == "approval"

    with Session(b_engine) as session:
        assert session.get(Course, cid) is not None
        assert session.get(CourseInvite, cid) is not None
        assert session.get(CourseCodeRegistry, created["code"].lower()) is not None
        decision = session.scalar(
            select(CourseLifecycleDecision).where(CourseLifecycleDecision.course_id == cid)
        )
        assert decision is not None and decision.action == "create"
        audit = session.scalar(
            select(AuditEvent).where(
                AuditEvent.course_id == cid, AuditEvent.action == "class.created"
            )
        )
        assert audit is not None

    # T2: Student and unverified teacher cannot create class; duplicate code -> 409
    api.as_user(world.student_ids[0])
    assert (
        api.post(
            "/api/v1/teacher/classes",
            json={
                "name": "非法班级",
                "semester": "2026-Autumn",
                "college": "CS",
                "project_deadline": future,
            },
        ).status_code
        == 403
    )
    api.as_user(unverified_teacher_id)
    assert (
        api.post(
            "/api/v1/teacher/classes",
            json={
                "name": "未验证教师班级",
                "semester": "2026-Autumn",
                "college": "CS",
                "project_deadline": future,
            },
        ).status_code
        == 422
    )
    api.as_user(world.teacher_id)
    dup = api.post(
        "/api/v1/teacher/classes",
        json={
            "name": "重复编号班级",
            "semester": "2026-Autumn",
            "college": "CS",
            "code": created["code"],
            "project_deadline": future,
        },
    )
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "COURSE_CODE_CONFLICT"

    # T3: Student previews and joins with invite code (approval mode creates pending request)
    with Session(b_engine) as session:
        outsider = add_student(session)
        session.commit()
        outsider_id = outsider.id
    api.as_user(outsider_id)
    prev = api.post("/api/v1/course-joins/preview", json={"invite_code": created["invite_code"]})
    assert prev.status_code == 200
    joined = api.post("/api/v1/course-joins", json={"invite_code": created["invite_code"]})
    assert joined.status_code == 201 and joined.json()["data"]["status"] == "pending"

    api.as_user(world.teacher_id)
    detail = api.get(f"/api/v1/teacher/classes/{cid}").json()["data"]
    assert detail["pending_join_count"] == 1

    # T4: Rotate invite code -> old code 404, new code works, wrong version -> 409
    old_code = detail["invite_code"]
    bad_ver = api.post(
        f"/api/v1/teacher/classes/{cid}/invite-code/rotate",
        json={"expected_version": detail["lock_version"] + 5},
    )
    assert bad_ver.status_code == 409 and bad_ver.json()["error"]["code"] == "VERSION_CONFLICT"

    rot = api.post(
        f"/api/v1/teacher/classes/{cid}/invite-code/rotate",
        json={"expected_version": detail["lock_version"]},
    )
    assert rot.status_code == 200
    new_code = rot.json()["data"]["invite_code"]
    assert new_code != old_code

    api.as_user(outsider_id)
    assert (
        api.post("/api/v1/course-joins/preview", json={"invite_code": old_code}).status_code == 404
    )
    assert (
        api.post("/api/v1/course-joins/preview", json={"invite_code": new_code}).status_code == 200
    )


def test_t5_permissions_and_ta_read_only(setup):
    api, world, other, loose, _unverified_id, ta_id = setup
    cid = world.course_id

    # Other course teacher and student get 403
    for uid in (other.teacher_id, world.student_ids[0]):
        api.as_user(uid)
        assert api.get(f"/api/v1/teacher/classes/{cid}/roster").status_code == 403
        assert api.get(f"/api/v1/teacher/classes/{cid}/plaza").status_code == 403
        assert api.get(f"/api/v1/teacher/classes/{cid}/groups/{world.group_id}").status_code == 403

    # TA can read roster, plaza, group detail, class detail, but cannot mutate
    api.as_user(ta_id)
    assert api.get(f"/api/v1/teacher/classes/{cid}").json()["data"]["can_manage"] is False
    assert api.get(f"/api/v1/teacher/classes/{cid}/roster").status_code == 200
    assert api.get(f"/api/v1/teacher/classes/{cid}/plaza").status_code == 200
    assert api.get(f"/api/v1/teacher/classes/{cid}/groups/{world.group_id}").status_code == 200
    assert (
        api.post(f"/api/v1/teacher/classes/{cid}/groups", json={"name": "TA Group"}).status_code
        == 403
    )
    assert (
        api.post(
            f"/api/v1/teacher/classes/{cid}/assignments",
            json={"student_id": str(loose[0]), "to_group_id": str(world.group_id)},
        ).status_code
        == 403
    )


def test_t6_t7_t8_t9_t10_t12_t13_t14_plaza_assign_remove_and_leader(setup, b_engine):
    api, world, other, loose, _unverified_id, _ta_id = setup
    cid = world.course_id
    api.as_user(world.teacher_id)

    # Create two empty groups (no project)
    g1 = api.post(
        f"/api/v1/teacher/classes/{cid}/groups",
        json={"name": "Alpha 队", "direction": "后端"},
    ).json()["data"]
    g2 = api.post(
        f"/api/v1/teacher/classes/{cid}/groups",
        json={"name": "Beta 队", "direction": "前端"},
    ).json()["data"]
    g1_id, g2_id = UUID(g1["id"]), UUID(g2["id"])

    # T12: Idempotency replay returns identical response; different payload -> 409
    idem_key = api.key()
    r_first = api.post(
        f"/api/v1/teacher/classes/{cid}/assignments",
        json={
            "student_id": str(loose[0]),
            "to_group_id": str(g1_id),
            "to_group_version": g1["lock_version"],
        },
        key=idem_key,
    )
    assert r_first.status_code == 200
    r_replay = api.post(
        f"/api/v1/teacher/classes/{cid}/assignments",
        json={
            "student_id": str(loose[0]),
            "to_group_id": str(g1_id),
            "to_group_version": g1["lock_version"],
        },
        key=idem_key,
    )
    assert r_replay.status_code == 200 and r_replay.json()["data"] == r_first.json()["data"]
    r_conflict = api.post(
        f"/api/v1/teacher/classes/{cid}/assignments",
        json={
            "student_id": str(loose[1]),
            "to_group_id": str(g1_id),
            "to_group_version": g1["lock_version"],
        },
        key=idem_key,
    )
    assert (
        r_conflict.status_code == 409
        and r_conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    )

    # T14: Set leader on g1; non-member -> 422
    g1_v = r_first.json()["data"]["to_group"]["lock_version"]
    bad_leader = api.post(
        f"/api/v1/teacher/classes/{cid}/groups/{g1_id}/leader",
        json={"user_id": str(loose[1]), "expected_version": g1_v},
    )
    assert (
        bad_leader.status_code == 422 and bad_leader.json()["error"]["code"] == "NOT_GROUP_MEMBER"
    )

    set_l = api.post(
        f"/api/v1/teacher/classes/{cid}/groups/{g1_id}/leader",
        json={"user_id": str(loose[0]), "expected_version": g1_v},
    )
    assert set_l.status_code == 200 and set_l.json()["data"]["leader_id"] == str(loose[0])
    g1_v = set_l.json()["data"]["lock_version"]

    # T8: Move loose[0] (leader of g1) from g1 to g2 -> g1.leader_id cleared, then remove from g2
    move = api.post(
        f"/api/v1/teacher/classes/{cid}/assignments",
        json={
            "student_id": str(loose[0]),
            "to_group_id": str(g2_id),
            "from_group_version": g1_v,
            "to_group_version": g2["lock_version"],
        },
    )
    assert move.status_code == 200
    assert move.json()["data"]["from_group"]["leader_id"] is None
    assert move.json()["data"]["to_group"]["member_count"] == 1
    g2_v = move.json()["data"]["to_group"]["lock_version"]

    unassign = api.post(
        f"/api/v1/teacher/classes/{cid}/assignments",
        json={
            "student_id": str(loose[0]),
            "to_group_id": None,
            "from_group_version": g2_v,
        },
    )
    assert (
        unassign.status_code == 200 and unassign.json()["data"]["from_group"]["member_count"] == 0
    )

    # T7: Member of group with a project (world.group_id) cannot be dragged out or switched
    proj_group = api.get(f"/api/v1/teacher/classes/{cid}/groups/{world.group_id}").json()["data"][
        "group"
    ]
    blocked = api.post(
        f"/api/v1/teacher/classes/{cid}/assignments",
        json={
            "student_id": str(world.student_ids[1]),
            "to_group_id": None,
            "from_group_version": proj_group["lock_version"],
        },
    )
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "GROUP_HAS_PROJECT"
    assert (
        blocked.json()["error"]["details"]["member_changes_href"]
        == f"/teacher/courses/{cid}/member-changes"
    )

    # T6: Assigning into a group with a project (after raising max_group_size) adds ProjectMember
    with Session(b_engine) as session:
        c_row = session.get(Course, cid)
        c_row.max_group_size = 6
        # T10: Expire formation_deadline — teacher can still assign!
        c_row.formation_deadline = datetime.now(UTC) - timedelta(days=1)
        session.commit()

    into_proj = api.post(
        f"/api/v1/teacher/classes/{cid}/assignments",
        json={
            "student_id": str(loose[0]),
            "to_group_id": str(world.group_id),
            "to_group_version": proj_group["lock_version"],
        },
    )
    assert into_proj.status_code == 200
    with Session(b_engine) as session:
        pm = session.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == world.project_id,
                ProjectMember.user_id == loose[0],
                ProjectMember.left_at.is_(None),
            )
        )
        assert pm is not None

    # T9: Other course group -> 404; roster_frozen -> 409 ROSTER_FROZEN
    wrong_course = api.post(
        f"/api/v1/teacher/classes/{cid}/assignments",
        json={
            "student_id": str(loose[1]),
            "to_group_id": str(other.group_id),
            "to_group_version": 0,
        },
    )
    assert wrong_course.status_code == 404

    with Session(b_engine) as session:
        g2_row = session.get(ProjectGroup, g2_id)
        g2_row.roster_frozen = True
        session.commit()
        g2_ver = g2_row.lock_version
    frozen_res = api.post(
        f"/api/v1/teacher/classes/{cid}/assignments",
        json={
            "student_id": str(loose[1]),
            "to_group_id": str(g2_id),
            "to_group_version": g2_ver,
        },
    )
    assert frozen_res.status_code == 409 and frozen_res.json()["error"]["code"] == "ROSTER_FROZEN"

    # T13: Remove student from class: grouped -> 409 STUDENT_IN_GROUP; ungrouped -> 200
    in_group_rm = api.post(
        f"/api/v1/teacher/classes/{cid}/students/{loose[0]}/remove",
        json={"reason": "测试移出已组队学生"},
    )
    assert (
        in_group_rm.status_code == 409 and in_group_rm.json()["error"]["code"] == "STUDENT_IN_GROUP"
    )

    ok_rm = api.post(
        f"/api/v1/teacher/classes/{cid}/students/{loose[1]}/remove",
        json={"reason": "退课移出"},
    )
    assert ok_rm.status_code == 200 and ok_rm.json()["data"]["status"] == "left"


def test_t11_concurrent_assign_to_last_seat_allows_only_one(setup, b_engine):
    b_test_database_url()
    api, world, _other, loose, _unverified_id, _ta_id = setup
    cid = world.course_id
    with Session(b_engine) as session:
        c = session.get(Course, cid)
        c.max_group_size = 1
        session.commit()

    api.as_user(world.teacher_id)
    g = api.post(f"/api/v1/teacher/classes/{cid}/groups", json={"name": "单人上限队"}).json()[
        "data"
    ]
    gid = g["id"]
    ver = g["lock_version"]
    barrier = Barrier(2)

    def attempt(student_id: UUID) -> int:
        with b_api(b_engine) as worker:
            worker.as_user(world.teacher_id)
            barrier.wait(timeout=5)
            resp = worker.post(
                f"/api/v1/teacher/classes/{cid}/assignments",
                json={
                    "student_id": str(student_id),
                    "to_group_id": gid,
                    "to_group_version": ver,
                },
            )
            return resp.status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        codes = sorted(pool.map(attempt, [loose[2], loose[3]]))
    assert codes == [200, 409]


def test_t15_t16_milestone_progress_states_and_consistency(setup, b_engine):
    api, world, _other, _loose, _unverified_id, _ta_id = setup
    cid = world.course_id
    api.as_user(world.teacher_id)

    # Create a group without project -> state == "no_project"
    no_proj = api.post(f"/api/v1/teacher/classes/{cid}/groups", json={"name": "未立项队"}).json()[
        "data"
    ]
    assert no_proj["progress"]["state"] == "no_project"
    assert no_proj["progress"]["overall_percent"] is None

    # world.group_id has a project but no milestones yet -> state == "no_milestones"
    detail0 = api.get(f"/api/v1/teacher/classes/{cid}/groups/{world.group_id}").json()["data"]
    assert detail0["group"]["progress"]["state"] == "no_milestones"
    assert detail0["group"]["progress"]["overall_percent"] is None

    # Add two milestones and linked tasks to world.project_id -> state == "tracking"
    with Session(b_engine) as session:
        mod = FunctionalModule(
            id=uuid4(),
            project_id=world.project_id,
            name="核心模块",
        )
        session.add(mod)
        session.flush()
        m1 = Milestone(
            id=uuid4(),
            project_id=world.project_id,
            title="M1 需求冻结",
            deadline=datetime.now(UTC) + timedelta(days=5),
            status="completed",
            progress_percent=100,
            sort_order=1,
        )
        m2 = Milestone(
            id=uuid4(),
            project_id=world.project_id,
            title="M2 原型实现",
            deadline=datetime.now(UTC) - timedelta(days=1),
            status="in_progress",
            progress_percent=0,
            sort_order=2,
        )
        t1 = Task(
            id=uuid4(),
            project_id=world.project_id,
            module_id=mod.id,
            title="任务 1",
            status="completed",
            progress_percent=100,
            weight=1,
        )
        t2 = Task(
            id=uuid4(),
            project_id=world.project_id,
            module_id=mod.id,
            title="任务 2",
            status="in_progress",
            progress_percent=40,
            weight=1,
        )
        session.add_all([m1, m2, t1, t2])
        session.flush()
        session.add_all(
            [
                TaskMilestone(task_id=t1.id, milestone_id=m1.id),
                TaskMilestone(task_id=t2.id, milestone_id=m2.id),
            ]
        )
        session.commit()

    detail1 = api.get(f"/api/v1/teacher/classes/{cid}/groups/{world.group_id}").json()["data"]
    prog = detail1["group"]["progress"]
    assert prog["state"] == "tracking"
    assert prog["milestones_total"] == 2
    assert prog["milestones_completed"] == 1
    assert prog["overall_percent"] == 70
    assert prog["next_milestone"]["title"] == "M2 原型实现"
    assert prog["overdue_count"] == 1

    # Compare with B-8 list_milestones endpoint
    b8 = api.get(f"/api/v1/projects/{world.project_id}/milestones").json()["data"]["items"]
    assert [m["id"] for m in detail1["milestones"]] == [m["id"] for m in b8]
