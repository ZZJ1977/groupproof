"""A→C 账号管理：管理员恢复/创建账号，教师审核的共享规则。"""

from uuid import UUID, uuid4

import pytest
import test_c_auth_verification_integration as fixtures
from sqlalchemy import func, select

from app.auth.errors import AppError
from app.auth.models import (
    AuthAuditEvent,
    PasswordCredential,
    SchoolEmailBinding,
    TeacherApplication,
    User,
)
from app.auth.services import accounts, sessions
from app.auth.services.registration import review_basis
from app.modules.a.models import Notification
from app.modules.c.notification_delivery import get_notification_writer

db, scope, http = fixtures.db, fixtures.scope, fixtures.http


def audit_count(db, event_type, target):
    return db.scalar(
        select(func.count())
        .select_from(AuthAuditEvent)
        .where(
            AuthAuditEvent.event_type == event_type, AuthAuditEvent.target_user_id == str(target)
        )
    )


def disable_then_enable(http, db, scope, expected_version=None):
    http.client.app.dependency_overrides[get_notification_writer] = lambda: None
    target = scope.users["member"]
    http.sign_in(scope.users["admin"])
    r = http.client.post(
        f"/api/v1/c-admin/users/{target.id}/disable",
        json={"expectedVersion": target.version, "reason": "暂停"},
    )
    assert r.status_code == 200, r.text
    return target, r.json()["data"]["version"]


def test_admin_can_restore_a_disabled_account(http, db, scope):
    target, version = disable_then_enable(http, db, scope)
    r = http.client.post(
        f"/api/v1/c-admin/users/{target.id}/enable",
        json={"expectedVersion": version, "reason": "误停用，已恢复"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"] == {"id": str(target.id), "status": "enabled", "version": version + 1}
    db.refresh(target)
    assert target.status == "active"
    assert target.disabled_reason is None and target.disabled_at is None
    assert audit_count(db, "user.enabled", target.id) == 1
    note = db.scalar(select(Notification).where(Notification.recipient_id == target.id))
    assert note is not None


def test_enable_rejects_stale_version_and_accounts_that_are_not_disabled(http, db, scope):
    target, version = disable_then_enable(http, db, scope)
    stale = http.client.post(
        f"/api/v1/c-admin/users/{target.id}/enable",
        json={"expectedVersion": version - 1, "reason": "x"},
    )
    assert stale.status_code == 409
    ok = http.client.post(
        f"/api/v1/c-admin/users/{target.id}/enable",
        json={"expectedVersion": version, "reason": "x"},
    )
    assert ok.status_code == 200
    again = http.client.post(
        f"/api/v1/c-admin/users/{target.id}/enable",
        json={"expectedVersion": version + 1, "reason": "x"},
    )
    assert again.status_code == 409


def create_body(**over):
    suffix = uuid4().hex[:8]
    body = {
        "identity": "student",
        "name": "新同学",
        "username": f"new_{suffix}",
        "schoolEmail": f"s{suffix}@student.must.edu.mo",
        "studentId": f"S{suffix}",
        "college": "计算机学院",
    }
    body.update(over)
    return body


def test_admin_creates_student_and_teacher_without_exposing_a_password(http, db, scope):
    http.sign_in(scope.users["admin"])
    r = http.client.post("/api/v1/c-admin/users", json=create_body())
    assert r.status_code == 201, r.text
    data = r.json()["data"]
    assert data["roles"] == ["student"] and data["status"] == "enabled"
    assert data["passwordSetup"] == "forgot_password"
    assert "password" not in {key.lower() for key in data if key != "passwordSetup"}
    created = db.get(User, UUID(data["id"]))
    assert created.email_binding.verified_at is not None
    assert created.email_binding.verification_method == "admin_created"
    credential = db.get(PasswordCredential, created.id)
    assert credential.login_email_verified_at is not None
    assert audit_count(db, "user.created_by_admin", created.id) == 1

    teacher = http.client.post(
        "/api/v1/c-admin/users",
        json=create_body(identity="teacher", schoolEmail=f"t{uuid4().hex[:8]}@must.edu.mo"),
    )
    assert teacher.status_code == 201, teacher.text
    assert teacher.json()["data"]["roles"] == ["teacher"]


def test_admin_create_rejects_duplicates_and_bad_input(http, db, scope):
    http.sign_in(scope.users["admin"])
    body = create_body()
    assert http.client.post("/api/v1/c-admin/users", json=body).status_code == 201
    same_email = http.client.post(
        "/api/v1/c-admin/users", json=create_body(schoolEmail=body["schoolEmail"])
    )
    assert same_email.status_code == 409
    same_name = http.client.post(
        "/api/v1/c-admin/users", json=create_body(username=body["username"])
    )
    assert same_name.status_code == 409
    wrong_domain = http.client.post(
        "/api/v1/c-admin/users", json=create_body(schoolEmail="x@gmail.com")
    )
    assert wrong_domain.status_code == 400
    bad_role = http.client.post("/api/v1/c-admin/users", json=create_body(identity="admin"))
    assert bad_role.status_code == 422


def test_admin_creates_pending_teacher_then_reviews_saved_application(http, db, scope):
    admin = scope.users["admin"]
    http.sign_in(admin)
    body = create_body(
        identity="teacher", name="待审教师", schoolEmail="pending@must.edu.mo", submitForReview=True
    )
    created = http.client.post("/api/v1/c-admin/users", json=body)
    assert created.status_code == 201, created.text
    user = db.get(User, UUID(created.json()["data"]["id"]))
    assert "teacher" not in user.roles
    assert sessions.current_facts(db, user)["accountState"] == "review_pending"
    listing = http.client.get("/api/v1/c-admin/teacher-applications", params={"status": "pending"})
    assert listing.status_code == 200, listing.text
    rows = [row for row in listing.json()["data"]["items"] if row["userId"] == str(user.id)]
    assert len(rows) == 1 and rows[0]["emailVerified"]
    assert db.scalar(
        select(Notification.id).where(
            Notification.recipient_id == admin.id, Notification.title == "新的教师身份审核申请"
        )
    )
    saved = http.client.post(
        f"/api/v1/c-admin/teacher-applications/{rows[0]['id']}/review",
        json={
            "expectedVersion": rows[0]["applicationVersion"],
            "decision": "approve",
            "reason": "资料一致",
        },
    )
    assert saved.status_code == 200, saved.text
    db.refresh(user)
    assert (
        user.roles == ["teacher"] and sessions.current_facts(db, user)["accountState"] == "active"
    )


def test_pending_teacher_creation_rolls_back_if_notification_fails(db, scope, monkeypatch):
    body = create_body(identity="teacher", schoolEmail="rollback@must.edu.mo")

    def fail(*_):
        raise RuntimeError("notification unavailable")

    monkeypatch.setattr(accounts, "_notify_admins_of_application", fail)
    prior = db.scalar(select(func.count()).select_from(TeacherApplication))
    with pytest.raises(RuntimeError, match="notification unavailable"), db.begin_nested():
        accounts.admin_create_account(
            db,
            admin=scope.users["admin"],
            name=body["name"],
            username=body["username"],
            school_email=body["schoolEmail"],
            identity="teacher",
            submit_for_review=True,
        )
    assert db.scalar(select(User.id).where(User.username == body["username"])) is None
    assert db.scalar(select(func.count()).select_from(TeacherApplication)) == prior


def test_create_requires_an_administrator(http, db, scope):
    http.sign_in(scope.users["member"])
    assert http.client.post("/api/v1/c-admin/users", json=create_body()).status_code == 403


def pending_application(db, user):
    row = TeacherApplication(
        id=uuid4().hex,
        user_id=user.id,
        application_version=user.version,
        snapshot=review_basis(user, user.email_binding),
        status="pending",
    )
    db.add(row)
    db.flush()
    return row


def test_shared_review_rule_requires_a_reason_to_reject(http, db, scope):
    teacher = scope.users["teacher"]
    http.sign_in(scope.users["admin"])
    row = pending_application(db, teacher)
    for reason in (None, "", "   "):
        with pytest.raises(AppError) as error:
            accounts.review_teacher_application(
                db,
                row,
                reviewer=scope.users["admin"],
                decision="reject",
                reason=reason,
                expected_version=row.application_version,
            )
        assert error.value.status == 400
    assert row.status == "pending"
    accounts.review_teacher_application(
        db,
        row,
        reviewer=scope.users["admin"],
        decision="reject",
        reason="材料不完整",
        expected_version=row.application_version,
    )
    assert row.status == "rejected"


def test_shared_review_rule_rechecks_school_email_at_approval(http, db, scope):
    teacher = scope.users["teacher"]
    http.sign_in(scope.users["admin"])
    row = pending_application(db, teacher)
    binding = db.get(SchoolEmailBinding, teacher.id)
    binding.verified_at = None
    row.snapshot = review_basis(teacher, binding)
    db.flush()
    with pytest.raises(AppError) as error:
        accounts.review_teacher_application(
            db,
            row,
            reviewer=scope.users["admin"],
            decision="approve",
            reason="ok",
            expected_version=row.application_version,
        )
    assert error.value.status == 422
    assert row.status == "pending"
