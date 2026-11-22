"""Tests for teacher course materials center, folder hierarchy, versions, and visibility."""

from __future__ import annotations

import base64
import os
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import JSON, DefaultClause, MetaData, create_engine, event, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapper, Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import CourseStaff
from app.modules.b.models import BCourseFileFolder, BCourseMaterialItem, BCourseMaterialVersion
from tests.b_fixtures import (
    _user,
    add_course_student,
    b_api,
    b_postgres_schema,
    b_test_database_url,
    build_b_world,
)

# Make ruff aware ORM classes exist in metadata
_MODELS = (BCourseFileFolder, BCourseMaterialItem, BCourseMaterialVersion)


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
        world = build_b_world(session, max_group_size=4)
        ungrouped_uid = add_course_student(session, world)
        ta = _user(session, tag=uuid4().hex[:8], role="ta", index=2, now=datetime.now(UTC))
        session.add(
            CourseStaff(course_id=world.course_id, user_id=ta.id, role="ta", permissions={})
        )
        ta_id = ta.id
        session.commit()
    with b_api(b_engine) as api:
        yield api, world, ungrouped_uid, ta_id


def test_folder_tree_versioned_upload_visibility_and_permissions(setup):
    api, world, ungrouped_uid, ta_id = setup
    cid = str(world.course_id)
    teacher_id = world.teacher_id
    grouped_student_id = world.student_ids[0]

    # 1. TA without manage_files is blocked from creating folders
    forbidden = api.as_user(ta_id).post(
        f"/api/v1/teacher/classes/{cid}/files/folders",
        json={"name": "教学大纲"},
    )
    assert forbidden.status_code == 403

    # Owner grants manage_files to TA
    grant = api.as_user(teacher_id).patch(
        f"/api/v1/teacher/classes/{cid}/staff/{ta_id}/permissions",
        json={"manage_files": True},
    )
    assert grant.status_code == 200

    # 2. Folder creation + root duplicate detection + rename + cycle guard
    r1 = api.as_user(ta_id).post(
        f"/api/v1/teacher/classes/{cid}/files/folders",
        json={"name": "教学大纲"},
    )
    assert r1.status_code == 201
    f_root = r1.json()["data"]["id"]

    dup = api.as_user(teacher_id).post(
        f"/api/v1/teacher/classes/{cid}/files/folders",
        json={"name": " 教学大纲 "},
    )
    assert dup.status_code == 409

    child = api.as_user(teacher_id).post(
        f"/api/v1/teacher/classes/{cid}/files/folders",
        json={"name": "第1周课件", "parent_id": f_root},
    )
    assert child.status_code == 201
    f_child = child.json()["data"]["id"]

    cycle = api.as_user(teacher_id).patch(
        f"/api/v1/teacher/classes/{cid}/files/folders/{f_root}",
        json={"parent_id": f_child},
    )
    assert cycle.status_code == 409

    # 3. Upload v1, append v2, download both versions
    v1_bytes = b"syllabus-version-1"
    up = api.as_user(teacher_id).post(
        f"/api/v1/teacher/classes/{cid}/files/upload",
        json={
            "name": "课程说明.txt",
            "folder_id": f_child,
            "visibility": "all",
            "mime_type": "text/plain",
            "content_base64": base64.b64encode(v1_bytes).decode("ascii"),
            "change_note": "初版大纲",
        },
    )
    assert up.status_code == 201
    mat_all_id = up.json()["data"]["item"]["id"]

    v2_bytes = b"syllabus-version-2-updated"
    v2 = api.as_user(teacher_id).post(
        f"/api/v1/teacher/classes/{cid}/files/{mat_all_id}/versions",
        json={
            "content_base64": base64.b64encode(v2_bytes).decode("ascii"),
            "change_note": "补充评分细则",
        },
    )
    assert v2.status_code == 201
    versions = v2.json()["data"]["versions"]
    assert [v["version_no"] for v in versions] == [2, 1]

    dl_v1 = api.as_user(teacher_id).get(
        f"/api/v1/teacher/classes/{cid}/files/{mat_all_id}/download?version_no=1"
    )
    assert dl_v1.status_code == 200
    assert dl_v1.content == v1_bytes

    dl_latest = api.as_user(teacher_id).get(
        f"/api/v1/teacher/classes/{cid}/files/{mat_all_id}/download"
    )
    assert dl_latest.status_code == 200
    assert dl_latest.content == v2_bytes

    # 4. Upload grouped-only, staff-only, and draft materials
    mat_grouped = (
        api.as_user(teacher_id)
        .post(
            f"/api/v1/teacher/classes/{cid}/files/upload",
            json={
                "name": "分组实验指导.pdf",
                "visibility": "grouped",
                "mime_type": "application/pdf",
            },
        )
        .json()["data"]["item"]["id"]
    )

    mat_staff = (
        api.as_user(teacher_id)
        .post(
            f"/api/v1/teacher/classes/{cid}/files/upload",
            json={"name": "助教批改手册.md", "visibility": "staff"},
        )
        .json()["data"]["item"]["id"]
    )

    api.as_user(teacher_id).post(
        f"/api/v1/teacher/classes/{cid}/files/upload",
        json={"name": "未发布草稿.md", "visibility": "all", "status": "draft"},
    )

    # Grouped student sees `all` + `grouped`, not `staff` or `draft`
    grouped_list = api.as_user(grouped_student_id).get(f"/api/v1/courses/{cid}/materials")
    assert grouped_list.status_code == 200
    grouped_ids = {item["id"] for item in grouped_list.json()["data"]["items"]}
    assert grouped_ids == {mat_all_id, mat_grouped}

    # Ungrouped student sees ONLY `all`, gets 403 downloading `grouped` or `staff`
    ungrouped_list = api.as_user(ungrouped_uid).get(f"/api/v1/courses/{cid}/materials")
    assert ungrouped_list.status_code == 200
    assert {item["id"] for item in ungrouped_list.json()["data"]["items"]} == {mat_all_id}

    blocked = api.as_user(ungrouped_uid).get(
        f"/api/v1/courses/{cid}/materials/{mat_grouped}/download"
    )
    assert blocked.status_code == 403

    staff_blocked = api.as_user(grouped_student_id).get(
        f"/api/v1/courses/{cid}/materials/{mat_staff}/download"
    )
    assert staff_blocked.status_code == 403

    # 5. Batch move & delete folder re-parents items to parent
    batch = api.as_user(teacher_id).post(
        f"/api/v1/teacher/classes/{cid}/files/batch",
        json={"ids": [mat_grouped], "action": "move", "folder_id": f_child},
    )
    assert batch.status_code == 200
    assert batch.json()["data"]["affected"] == 1

    del_child = api.as_user(teacher_id).delete(
        f"/api/v1/teacher/classes/{cid}/files/folders/{f_child}"
    )
    assert del_child.status_code == 200

    in_root_parent = api.as_user(teacher_id).get(
        f"/api/v1/teacher/classes/{cid}/files?folder_id={f_root}"
    )
    assert in_root_parent.status_code == 200
    assert {i["id"] for i in in_root_parent.json()["data"]["items"]} == {
        mat_all_id,
        mat_grouped,
    }
