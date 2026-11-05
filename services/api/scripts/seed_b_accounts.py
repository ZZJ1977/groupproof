"""Local acceptance accounts for the B pages (development / test databases only).

Creates (or resets) one teacher and four students that can sign in with a
password and reach a full session, plus one active course owned by the
teacher with an invite code, so the students can try "join course" on page 32.
The students are NOT added to the course: joining is part of what to try.

Run from services/api:

    APP_ENV=development python -m scripts.seed_b_accounts

Running it again resets the passwords and keeps everything else; it refuses to
run when APP_ENV is anything other than development or test.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.models import PasswordCredential, SchoolEmailBinding, TeacherApplication
from app.auth.security import hash_password, normalize_email, normalize_username
from app.auth.services.registration import review_basis
from app.db.models import Course, CourseStaff, User
from app.db.seed import require_seed_environment
from app.db.session import SessionLocal
from app.modules.c.governance_models import CourseInvite

PASSWORD = "GroupProof-B-2026"
COURSE_CODE = "B-ACCEPT"
INVITE_CODE = "B-ACCEPTANCE-INVITE-2026"
TEACHER = ("b-teacher", "陈老师", "b.teacher@must.edu.mo", None)
STUDENTS = (
    ("b-student1", "张三", "b.student1@student.must.edu.mo", "B2026001"),
    ("b-student2", "李四", "b.student2@student.must.edu.mo", "B2026002"),
    ("b-student3", "王五", "b.student3@student.must.edu.mo", "B2026003"),
    ("b-student4", "赵六", "b.student4@student.must.edu.mo", "B2026004"),
)


def _account(session: Session, spec, identity: str, now: datetime) -> User:
    username, name, email, student_id = spec
    user = session.scalar(select(User).where(User.username_normalized == username))
    if user is None:
        user = User(id=uuid4(), username=username, username_normalized=username, email=email)
        session.add(user)
    user.name = name
    user.email = email
    user.student_id = student_id
    user.college = "GroupProof"
    user.requested_identity = identity
    user.global_role = identity
    user.status = "active"
    session.flush()

    binding = session.get(SchoolEmailBinding, user.id)
    if binding is None:
        binding = SchoolEmailBinding(user_id=user.id)
        session.add(binding)
    binding.school_email = email
    binding.school_email_normalized = normalize_email(email)
    binding.verified_at = binding.verified_at or now
    binding.verification_method = "documented_manual_review"

    credential = session.get(PasswordCredential, user.id)
    if credential is None:
        credential = PasswordCredential(
            user_id=user.id,
            login_email=email,
            login_email_normalized=normalize_email(email),
        )
        session.add(credential)
    credential.login_email_verified_at = credential.login_email_verified_at or now
    credential.password_hash = hash_password(PASSWORD)
    credential.password_algo = "argon2id"
    session.flush()
    session.refresh(user)

    if identity == "teacher":
        basis = review_basis(user, binding)
        approved = session.scalar(
            select(TeacherApplication).where(
                TeacherApplication.user_id == user.id, TeacherApplication.status == "approved"
            )
        )
        if approved is None or approved.snapshot != basis:
            session.add(
                TeacherApplication(
                    id=uuid4().hex,
                    user_id=user.id,
                    application_version=1,
                    snapshot=basis,
                    status="approved",
                    reviewed_at=now,
                    reason="本地验收账号",
                )
            )
    return user


def _course(session: Session, teacher: User, now: datetime) -> Course:
    course = session.scalar(select(Course).where(Course.code == COURSE_CODE))
    if course is None:
        course = Course(
            id=uuid4(),
            owner_id=teacher.id,
            code=COURSE_CODE,
            name="软件工程（B 模块验收）",
            college="GroupProof",
            semester="2026-Fall",
            status="active",
            grouping_mode="free",
            min_group_size=2,
            max_group_size=5,
        )
        session.add(course)
    course.formation_deadline = now + timedelta(days=14)
    course.project_deadline = now + timedelta(days=90)
    session.flush()
    if session.get(CourseStaff, (course.id, teacher.id)) is None:
        session.add(CourseStaff(course_id=course.id, user_id=teacher.id, role="teacher"))
    invite = session.get(CourseInvite, course.id)
    if invite is None:
        session.add(CourseInvite(course_id=course.id, code=INVITE_CODE, created_by=teacher.id))
    else:
        invite.code, invite.revoked_at = INVITE_CODE, None
    return course


def seed_b_accounts(session: Session) -> dict[str, str]:
    require_seed_environment()
    now = datetime.now(ZoneInfo("Asia/Shanghai"))
    teacher = _account(session, TEACHER, "teacher", now)
    students = [_account(session, spec, "student", now) for spec in STUDENTS]
    course = _course(session, teacher, now)
    session.commit()
    result = {"password": PASSWORD, "course_id": str(course.id), "invite_code": INVITE_CODE}
    result["teacher"] = normalize_username(teacher.username)
    for index, student in enumerate(students, start=1):
        result[f"student{index}"] = normalize_username(student.username)
    return result


def main() -> None:
    with SessionLocal() as session:
        for key, value in seed_b_accounts(session).items():
            print(f"{key}={value}")


if __name__ == "__main__":
    main()
