"""B baseline snapshot pins exact published C course file versions at freeze time."""

from __future__ import annotations

from uuid import uuid4

import test_c_discussions as discussion_tests

from app.modules.b.baseline_service import _snapshot
from app.modules.b.models import BCourseMaterialItem, BCourseMaterialVersion
from app.modules.c.course_files_models import CourseFile, CourseFileVersion

db = discussion_tests.db
scope = discussion_tests.scope


def test_baseline_snapshot_records_published_course_file_and_version_pairs(db, scope):
    teacher = scope.users["teacher"]

    # Published course file (v1 official)
    published_file = CourseFile(
        id=uuid4(),
        course_id=scope.course.id,
        name="course-rubric.pdf",
        name_key="course-rubric.pdf",
        category="documents",
        latest_version_no=2,
        official_version_no=1,
        created_by=teacher.id,
    )
    # Unpublished draft course file (official_version_no is None)
    draft_file = CourseFile(
        id=uuid4(),
        course_id=scope.course.id,
        name="draft-notes.pdf",
        name_key="draft-notes.pdf",
        category="documents",
        latest_version_no=1,
        official_version_no=None,
        created_by=teacher.id,
    )
    db.add_all([published_file, draft_file])
    db.flush()

    v1 = CourseFileVersion(
        id=uuid4(),
        file_id=published_file.id,
        version_no=1,
        receipt_id=uuid4(),
        storage_provider="supabase",
        storage_object_id="course/rubric-v1.pdf",
        storage_revision="rev-1",
        content_hash="a" * 64,
        original_name="course-rubric-v1.pdf",
        extension="pdf",
        mime_type="application/pdf",
        size_bytes=1024,
        uploaded_by=teacher.id,
    )
    v2_unpub = CourseFileVersion(
        id=uuid4(),
        file_id=published_file.id,
        version_no=2,
        receipt_id=uuid4(),
        storage_provider="supabase",
        storage_object_id="course/rubric-v2.pdf",
        storage_revision="rev-2",
        content_hash="b" * 64,
        original_name="course-rubric-v2.pdf",
        extension="pdf",
        mime_type="application/pdf",
        size_bytes=2048,
        uploaded_by=teacher.id,
    )
    draft_v1 = CourseFileVersion(
        id=uuid4(),
        file_id=draft_file.id,
        version_no=1,
        receipt_id=uuid4(),
        storage_provider="supabase",
        storage_object_id="course/draft-v1.pdf",
        storage_revision="rev-draft",
        content_hash="c" * 64,
        original_name="draft-notes.pdf",
        extension="pdf",
        mime_type="application/pdf",
        size_bytes=512,
        uploaded_by=teacher.id,
    )
    db.add_all([v1, v2_unpub, draft_v1])
    db.flush()

    b_pub = BCourseMaterialItem(
        id=uuid4(),
        course_id=scope.course.id,
        name="teaching-guide.md",
        visibility="all",
        status="published",
        latest_version_no=1,
        mime_type="text/markdown",
        size_bytes=256,
        uploaded_by=teacher.id,
    )
    b_staff = BCourseMaterialItem(
        id=uuid4(),
        course_id=scope.course.id,
        name="ta-only.md",
        visibility="staff",
        status="published",
        latest_version_no=1,
        mime_type="text/markdown",
        size_bytes=128,
        uploaded_by=teacher.id,
    )
    db.add_all([b_pub, b_staff])
    db.flush()

    b_pub_v1 = BCourseMaterialVersion(
        id=uuid4(),
        material_id=b_pub.id,
        version_no=1,
        original_name="teaching-guide.md",
        mime_type="text/markdown",
        size_bytes=256,
        checksum="d" * 64,
        uploaded_by=teacher.id,
    )
    b_staff_v1 = BCourseMaterialVersion(
        id=uuid4(),
        material_id=b_staff.id,
        version_no=1,
        original_name="ta-only.md",
        mime_type="text/markdown",
        size_bytes=128,
        checksum="e" * 64,
        uploaded_by=teacher.id,
    )
    db.add_all([b_pub_v1, b_staff_v1])
    db.flush()

    snap = _snapshot(db, scope.project, version_no=1)
    assert len(snap["course_files"]) == 2
    by_source = {row["source"]: row for row in snap["course_files"]}

    pinned = by_source["c_course_file"]
    assert pinned["file_id"] == str(published_file.id)
    assert pinned["version_id"] == str(v1.id)
    assert pinned["version_no"] == 1
    assert pinned["name"] == "course-rubric.pdf"
    assert pinned["content_hash"] == "a" * 64

    pinned_b = by_source["b_material"]
    assert pinned_b["file_id"] == str(b_pub.id)
    assert pinned_b["version_id"] == str(b_pub_v1.id)
    assert pinned_b["version_no"] == 1
    assert pinned_b["name"] == "teaching-guide.md"
    assert pinned_b["content_hash"] == "d" * 64
