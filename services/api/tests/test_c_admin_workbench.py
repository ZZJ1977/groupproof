"""Tests for the GroupProof Admin Workbench API and enhanced c-admin operations."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
import test_c_auth_verification_integration as auth_tests
from sqlalchemy import func, select

from app.auth.models import (
    AuthAuditEvent,
    AuthIdentity,
    EmailChallenge,
    RateLimitCounter,
    TeacherApplication,
    VerifiedGithubIdentity,
)
from app.auth.models import (
    Session as AuthSession,
)
from app.db.models import ProjectGroup, User
from app.modules.a.models import (
    AccessGrant,
    ActivitySummary,
    AiUsageEvent,
    AuditEvent,
    FeishuAttachment,
    FeishuChatLink,
    FeishuMessage,
    GithubActivity,
    GithubRepoLink,
    Notification,
    UploadReceipt,
)
from app.modules.a.router import router as a_router
from app.modules.c.admin_workbench_router import router as workbench_router
from app.modules.c.governance_models import (
    AccessRequest,
    GovernanceOutbox,
)
from app.modules.c.governance_models import (
    CourseInvite as GovCourseInvite,
)
from app.modules.c.models import Evidence

db = auth_tests.db
scope = auth_tests.scope
auth_http = auth_tests.http
bind = auth_tests.bind


@pytest.fixture()
def http(auth_http):
    app = auth_http.client.app
    paths = {getattr(route, "path", None) for route in app.routes}
    if "/api/v1/admin/workbench/overview" not in paths:
        app.include_router(workbench_router, prefix="/api/v1")
    if "/api/v1/a/access-grants/{grant_id}/revoke" not in paths:
        app.include_router(a_router)
    return auth_http


def _make_evidence(db, scope, actor_id, *, status="formal") -> Evidence:
    now = datetime.now(UTC)
    ev = Evidence(
        id=uuid4(),
        project_id=scope.project.id,
        task_id=scope.task.id,
        author_id=actor_id,
        title="正式实验证据",
        description="Private evidence body must stay hidden from workbench overview",
        source_type="manual",
        status=status,
        created_at=now,
        updated_at=now,
    )
    db.add(ev)
    return ev


def test_workbench_requires_verified_active_admin(http, db, scope):
    member = scope.users["member"]
    admin = scope.users["admin"]

    # Unauthenticated
    unauth = http.client.get("/api/v1/admin/workbench/overview")
    assert unauth.status_code == 401

    # Student / member cannot access any workbench endpoint
    http.sign_in(member)
    for method, url, payload in [
        ("get", "/api/v1/admin/workbench/overview", None),
        ("get", f"/api/v1/admin/workbench/users/{member.id}/profile", None),
        ("get", "/api/v1/admin/workbench/access-grants", None),
        ("get", "/api/v1/admin/workbench/ai-diagnostics", None),
        ("get", "/api/v1/admin/workbench/integrations", None),
        ("post", "/api/v1/admin/workbench/resolve-labels", {}),
        ("post", "/api/v1/admin/workbench/courses/metrics", {"course_ids": [str(scope.course.id)]}),
        (
            "post",
            f"/api/v1/admin/workbench/users/{member.id}/sessions/revoke",
            {"reason": "test"},
        ),
    ]:
        resp = http.client.get(url) if method == "get" else http.client.post(url, json=payload)
        assert resp.status_code == 403, f"Expected 403 on {url}, got {resp.status_code}"

    # Another non-admin user (outsider) cannot access workbench
    http.sign_in(scope.users["outsider"], student_id="ST0002")
    assert http.client.get("/api/v1/admin/workbench/overview").status_code == 403

    # Admin with revoked school email verification cannot read workbench
    http.sign_in(admin)
    assert http.client.get("/api/v1/admin/workbench/overview").status_code == 200
    admin.email_binding.verified_at = None
    db.flush()
    assert http.client.get("/api/v1/admin/workbench/overview").status_code == 403


def test_workbench_overview_aggregates_and_hides_private_bodies(http, db, scope):
    admin = scope.users["admin"]
    author = scope.users["author"]
    teacher = scope.users["teacher"]
    bind(db, author)
    now = datetime.now(UTC)

    # Queue items: teacher application + access request + grant + outbox
    db.add(
        TeacherApplication(
            id=str(uuid4()),
            user_id=author.id,
            application_version=1,
            snapshot={
                "name": "Author",
                "college": "Engineering",
                "schoolEmail": "author@must.edu.mo",
            },
            status="pending",
            created_at=now,
        )
    )
    req_id = uuid4()
    db.add(
        AccessRequest(
            id=req_id,
            applicant_id=scope.users["outsider"].id,
            project_id=scope.project.id,
            scope_json={
                "project_id": str(scope.project.id),
                "resource_type": "project",
                "resource_id": str(scope.project.id),
            },
            reason="Peer review",
            status="pending",
            requested_expires_at=now + timedelta(days=2),
            created_at=now,
            updated_at=now,
            lock_version=0,
        )
    )
    db.add(
        AccessGrant(
            id=uuid4(),
            request_id=req_id,
            command_id=uuid4(),
            applicant_id=scope.users["outsider"].id,
            reviewer_id=admin.id,
            project_id=scope.project.id,
            resource_type="project",
            resource_id=scope.project.id,
            expires_at=now + timedelta(hours=12),
            created_at=now,
        )
    )
    db.add(
        GovernanceOutbox(
            id=uuid4(),
            aggregate_id=scope.course.id,
            event_type="course.published",
            payload_json={"course_id": str(scope.course.id)},
            created_at=now,
        )
    )

    # Proof pipeline: GitHub, Feishu (secret body), uploads, email challenges, notifications
    gh_healthy = GithubRepoLink(
        id=uuid4(),
        project_id=scope.project.id,
        owner="groupproof",
        repo="demo-healthy",
        installation_id=101,
        default_branch="main",
        linked_by_id=author.id,
        linked_at=now - timedelta(days=2),
        last_synced_at=now - timedelta(hours=1),
    )
    gh_stale = GithubRepoLink(
        id=uuid4(),
        project_id=scope.other_project.id,
        owner="groupproof",
        repo="demo-stale",
        installation_id=102,
        default_branch="main",
        linked_by_id=author.id,
        linked_at=now - timedelta(days=5),
        last_synced_at=now - timedelta(hours=72),
    )
    db.add_all([gh_healthy, gh_stale])
    db.flush()
    db.add(
        GithubActivity(
            id=uuid4(),
            project_id=scope.project.id,
            link_id=gh_healthy.id,
            kind="commit",
            external_id="sha-1",
            title="Initial commit",
            summary="commit",
            revision="rev1",
            occurred_at=now - timedelta(hours=2),
            deleted=False,
            synced_at=now,
        )
    )
    db.add(
        FeishuChatLink(
            id=uuid4(),
            project_id=scope.project.id,
            chat_id="oc_overview_secret_chat_01",
            linked_by_id=author.id,
            linked_at=now - timedelta(days=1),
        )
    )
    db.add(
        FeishuMessage(
            id=uuid4(),
            project_id=scope.project.id,
            chat_id="oc_overview_secret_chat_01",
            message_id="om_1",
            sender_type="user",
            msg_type="text",
            text="TOP_SECRET_FEISHU_CHAT_BODY",
            content_hash="hash1",
            occurred_at=now - timedelta(hours=3),
            deleted=False,
            version_no=1,
            synced_at=now,
        )
    )
    db.add_all(
        [
            UploadReceipt(
                id=uuid4(),
                scope="project",
                scope_id=scope.project.id,
                actor_id=author.id,
                provider="r2",
                bucket="proofs",
                object_id="obj-1",
                filename="report.pdf",
                declared_mime="application/pdf",
                declared_size=2048,
                size_bytes=2048,
                status="completed",
                scan_status="clean",
                created_at=now - timedelta(hours=4),
                upload_expires_at=now + timedelta(hours=4),
            ),
            UploadReceipt(
                id=uuid4(),
                scope="project",
                scope_id=scope.project.id,
                actor_id=author.id,
                provider="r2",
                bucket="proofs",
                object_id="obj-2",
                filename="bad.exe",
                declared_mime="application/octet-stream",
                declared_size=512,
                status="rejected",
                scan_status="rejected",
                created_at=now - timedelta(hours=4),
                upload_expires_at=now + timedelta(hours=4),
            ),
        ]
    )
    db.add_all(
        [
            EmailChallenge(
                id=str(uuid4()),
                user_id=author.id,
                email="author@student.must.edu.mo",
                email_normalized="author@student.must.edu.mo",
                purpose="school_verify",
                code_hmac="hmac1",
                send_status="accepted",
                expires_at=now + timedelta(minutes=10),
                resend_available_at=now,
                created_at=now - timedelta(hours=1),
            ),
            EmailChallenge(
                id=str(uuid4()),
                user_id=teacher.id,
                email="teacher@must.edu.mo",
                email_normalized="teacher@must.edu.mo",
                purpose="school_verify",
                code_hmac="hmac2",
                send_status="failed",
                expires_at=now + timedelta(minutes=10),
                resend_available_at=now,
                created_at=now - timedelta(hours=1),
            ),
            Notification(
                id=uuid4(),
                recipient_id=author.id,
                category="system",
                title="Notice",
                description="desc",
                created_at=now - timedelta(hours=1),
                lock_version=0,
                email_status="failed",
                email_attempts=1,
            ),
        ]
    )
    _make_evidence(db, scope, author.id, status="formal")
    db.add_all(
        [
            AiUsageEvent(
                id=uuid4(),
                occurred_at=now - timedelta(hours=2),
                user_id=author.id,
                project_id=scope.project.id,
                feature="chat",
                provider="openrouter",
                model="openai/gpt-4o",
                success=True,
                input_tokens=1000,
                output_tokens=200,
                cost=Decimal("0.0125"),
                currency="USD",
                latency_ms=250,
            ),
            AiUsageEvent(
                id=uuid4(),
                occurred_at=now - timedelta(hours=1),
                user_id=author.id,
                project_id=scope.project.id,
                feature="chat",
                provider="openrouter",
                model="openai/gpt-4o",
                success=False,
                error_code="RATE_LIMIT",
                input_tokens=100,
                output_tokens=0,
                latency_ms=420,
            ),
        ]
    )
    db.add(
        AuditEvent(
            id=uuid4(),
            occurred_at=now - timedelta(hours=1),
            actor_id=admin.id,
            actor_role="admin",
            action="course.updated",
            target_type="course",
            target_id=str(scope.course.id),
            result="success",
        )
    )
    db.commit()
    http.sign_in(admin)

    resp = http.client.get("/api/v1/admin/workbench/overview")
    assert resp.status_code == 200, resp.text
    assert "TOP_SECRET_FEISHU_CHAT_BODY" not in resp.text
    assert "oc_overview_secret_chat_01" not in resp.text
    data = resp.json()["data"]

    assert data["users"]["total"] >= 5
    assert data["queues"]["pending_teacher_applications"] >= 1
    assert data["queues"]["pending_access_requests"] >= 1
    assert data["queues"]["active_access_grants"] >= 1
    assert data["queues"]["undelivered_outbox"] >= 1
    assert data["teaching"]["courses_total"] >= 1
    assert data["teaching"]["projects_total"] >= 2
    assert data["teaching"]["tasks_total"] >= 2
    assert data["teaching"]["formal_evidences_total"] >= 1

    pp = data["proof_pipeline"]
    assert pp["github_repo_links"] >= 2
    assert pp["github_synced_24h"] >= 1
    assert pp["github_stale_links"] >= 1
    assert pp["feishu_chat_links"] >= 1
    assert pp["feishu_messages_7d"] >= 1
    assert pp["upload_completed_count"] >= 1
    assert pp["upload_total_bytes"] >= 2048
    assert pp["upload_rejected_count"] >= 1
    assert pp["email_challenges_7d"] >= 2
    assert pp["email_challenges_failed_7d"] >= 1
    assert pp["notification_emails_failed_7d"] >= 1

    ai = data["ai_7d"]
    assert ai["requests"] >= 2
    assert ai["succeeded"] >= 1
    assert ai["failed"] >= 1
    assert ai["cost_by_currency"]["USD"] == "0.0125"
    assert any(err["error_code"] == "RATE_LIMIT" and err["count"] >= 1 for err in ai["top_errors"])

    assert len(data["activity_7d"]) == 7
    assert len(data["recent_users"]) >= 1
    assert {item["key"] for item in data["system_health"]} == {
        "identity_db",
        "governance_outbox",
        "ai_gateway",
        "proof_integrations",
    }


def test_user_profile_360_and_force_revoke_sessions(http, db, scope):
    admin = scope.users["admin"]
    member = scope.users["member"]
    bind(db, member)
    now = datetime.now(UTC)

    # Sign in as member first to produce a real active session
    member_signed = http.sign_in(member)
    member_session_id = member_signed.record.id
    old_auth_version = member.auth_version

    # Enrich member's verification & telemetry footprint
    db.add(
        AuthIdentity(
            id=str(uuid4()),
            provider="google",
            issuer="https://accounts.google.com",
            subject="google-sub-member-1",
            user_id=member.id,
            google_email="member.google@gmail.com",
            created_at=now,
            last_authenticated_at=now,
        )
    )
    db.add(
        VerifiedGithubIdentity(
            user_id=member.id,
            github_user_id=987654,
            login="member-gh",
            verified_at=now,
        )
    )
    db.add(
        AiUsageEvent(
            id=uuid4(),
            occurred_at=now - timedelta(days=1),
            user_id=member.id,
            project_id=scope.project.id,
            feature="summary",
            provider="openrouter",
            model="openai/gpt-4o-mini",
            success=True,
            input_tokens=400,
            output_tokens=100,
            cost=Decimal("0.0020"),
            currency="USD",
        )
    )
    db.commit()

    # Sign in as admin to read profile 360
    http.sign_in(admin)
    prof_resp = http.client.get(f"/api/v1/admin/workbench/users/{member.id}/profile")
    assert prof_resp.status_code == 200, prof_resp.text
    prof = prof_resp.json()["data"]
    assert prof["user_id"] == str(member.id)
    assert prof["verification"]["school_email_verified"] is True
    assert prof["verification"]["google_linked"] is True
    assert prof["verification"]["google_email"] == "member.google@gmail.com"
    assert prof["verification"]["github_verified"] is True
    assert prof["verification"]["github_login"] == "member-gh"
    assert prof["sessions"]["active_count"] >= 1
    assert any(s["id"] == member_session_id for s in prof["sessions"]["recent"])
    assert prof["ai_30d"]["requests"] >= 1
    assert prof["ai_30d"]["cost_by_currency"]["USD"] == "0.002"

    # Unknown user -> 404
    assert http.client.get(f"/api/v1/admin/workbench/users/{uuid4()}/profile").status_code == 404

    # Revoke member sessions
    rev_resp = http.client.post(
        f"/api/v1/admin/workbench/users/{member.id}/sessions/revoke",
        json={"reason": "Compromised browser reported by student"},
    )
    assert rev_resp.status_code == 200, rev_resp.text
    rev_data = rev_resp.json()["data"]
    assert rev_data["user_id"] == str(member.id)
    assert rev_data["revoked_count"] >= 1
    assert rev_data["auth_version"] == old_auth_version + 1

    # Self-revoke blocked (run after successful write so SQLite rollback won't expire session)
    http.sign_in(admin)
    self_rev = http.client.post(
        f"/api/v1/admin/workbench/users/{admin.id}/sessions/revoke",
        json={"reason": "Should fail"},
    )
    assert self_rev.status_code == 403
    assert self_rev.json()["error"]["code"] == "CANNOT_REVOKE_SELF"

    db.expire_all()
    sess = db.get(AuthSession, member_session_id)
    assert sess is not None and sess.revoked_at is not None
    assert sess.revoke_reason == "admin_forced_logout"

    audit_row = db.scalar(
        select(AuditEvent).where(
            AuditEvent.action == "admin.user.sessions_revoked",
            AuditEvent.target_id == str(member.id),
        )
    )
    assert audit_row is not None
    auth_ev = db.scalar(
        select(AuthAuditEvent).where(
            AuthAuditEvent.event_type == "auth.logout",
            AuthAuditEvent.target_user_id == str(member.id),
        )
    )
    assert auth_ev is not None


def test_access_grants_list_filter_and_revoke_integration(http, db, scope):
    admin = scope.users["admin"]
    outsider = scope.users["outsider"]
    now = datetime.now(UTC)

    req_active = uuid4()
    req_expired = uuid4()
    req_revoked = uuid4()
    for rid, state in [
        (req_active, "approved"),
        (req_expired, "approved"),
        (req_revoked, "approved"),
    ]:
        db.add(
            AccessRequest(
                id=rid,
                applicant_id=outsider.id,
                project_id=scope.project.id,
                scope_json={
                    "project_id": str(scope.project.id),
                    "resource_type": "project",
                    "resource_id": str(scope.project.id),
                },
                reason=f"Review {state}",
                status="approved",
                requested_expires_at=now + timedelta(days=1),
                approved_expires_at=now + timedelta(days=1),
                authorization_receipt={"grant_id": str(uuid4())},
                created_at=now,
                updated_at=now,
                lock_version=1,
            )
        )
    grant_active = AccessGrant(
        id=uuid4(),
        request_id=req_active,
        command_id=uuid4(),
        applicant_id=outsider.id,
        reviewer_id=admin.id,
        project_id=scope.project.id,
        resource_type="project",
        resource_id=scope.project.id,
        expires_at=now + timedelta(hours=6),
        created_at=now,
    )
    grant_expired = AccessGrant(
        id=uuid4(),
        request_id=req_expired,
        command_id=uuid4(),
        applicant_id=outsider.id,
        reviewer_id=admin.id,
        project_id=scope.project.id,
        resource_type="task",
        resource_id=scope.task.id,
        expires_at=now - timedelta(hours=1),
        created_at=now - timedelta(hours=2),
    )
    grant_revoked = AccessGrant(
        id=uuid4(),
        request_id=req_revoked,
        command_id=uuid4(),
        applicant_id=outsider.id,
        reviewer_id=admin.id,
        project_id=scope.project.id,
        resource_type="project",
        resource_id=scope.project.id,
        expires_at=now + timedelta(hours=6),
        revoked_at=now - timedelta(minutes=10),
        revoked_by_id=admin.id,
        revoke_reason="Early revoke test",
        created_at=now - timedelta(hours=1),
    )
    db.add_all([grant_active, grant_expired, grant_revoked])
    db.commit()
    http.sign_in(admin)

    active_page = http.client.get("/api/v1/admin/workbench/access-grants?status=active").json()[
        "data"
    ]
    assert {item["id"] for item in active_page["items"]} == {str(grant_active.id)}
    assert active_page["items"][0]["project_name"] == scope.project.name
    assert active_page["items"][0]["course_code"] == scope.course.code
    assert active_page["items"][0]["state"] == "active"

    expired_page = http.client.get("/api/v1/admin/workbench/access-grants?status=expired").json()[
        "data"
    ]
    assert {item["id"] for item in expired_page["items"]} == {str(grant_expired.id)}
    assert expired_page["items"][0]["state"] == "expired"

    revoked_page = http.client.get("/api/v1/admin/workbench/access-grants?status=revoked").json()[
        "data"
    ]
    assert {item["id"] for item in revoked_page["items"]} == {str(grant_revoked.id)}
    assert revoked_page["items"][0]["revoke_reason"] == "Early revoke test"

    all_page = http.client.get("/api/v1/admin/workbench/access-grants?status=all").json()["data"]
    assert all_page["total"] >= 3

    # Revoke active grant through /api/v1/a/access-grants/{id}/revoke
    rev_resp = http.client.post(
        f"/api/v1/a/access-grants/{grant_active.id}/revoke",
        json={"reason": "Done checking evidence"},
    )
    assert rev_resp.status_code == 200, rev_resp.text

    after_active = http.client.get("/api/v1/admin/workbench/access-grants?status=active").json()[
        "data"
    ]
    assert all(item["id"] != str(grant_active.id) for item in after_active["items"])
    after_revoked = http.client.get("/api/v1/admin/workbench/access-grants?status=revoked").json()[
        "data"
    ]
    revoked_ids = {item["id"] for item in after_revoked["items"]}
    assert str(grant_active.id) in revoked_ids


def test_ai_diagnostics_breakdown_percentiles_and_summary_jobs(http, db, scope):
    admin = scope.users["admin"]
    author = scope.users["author"]
    member = scope.users["member"]
    now = datetime.now(UTC)

    latencies = [100, 200, 300, 400, 1000]
    for idx, lat in enumerate(latencies):
        is_ok = idx < 3
        db.add(
            AiUsageEvent(
                id=uuid4(),
                occurred_at=now - timedelta(hours=idx + 1),
                user_id=author.id if idx < 4 else member.id,
                project_id=scope.project.id,
                feature="chat" if idx < 4 else "review",
                provider="openrouter",
                model="openai/gpt-4o" if idx < 4 else "anthropic/claude-3.5-sonnet",
                success=is_ok,
                error_code=None if is_ok else ("TIMEOUT" if idx == 3 else "RATE_LIMIT"),
                input_tokens=200,
                output_tokens=50 if is_ok else 0,
                cost=Decimal("0.0100") if is_ok else None,
                currency="USD" if is_ok else None,
                latency_ms=lat,
            )
        )
    db.add_all(
        [
            ActivitySummary(
                id=uuid4(),
                project_id=scope.project.id,
                source_type="github",
                source_id=uuid4(),
                source_revision="r1",
                prompt_version="v1",
                input_hash="h1",
                status="pending",
                is_placeholder=False,
                needs_human_review=False,
                created_at=now,
                updated_at=now,
            ),
            ActivitySummary(
                id=uuid4(),
                project_id=scope.project.id,
                source_type="feishu",
                source_id=uuid4(),
                source_revision="r2",
                prompt_version="v1",
                input_hash="h2",
                status="failed",
                is_placeholder=False,
                needs_human_review=True,
                error_code="LLM_ERR",
                created_at=now,
                updated_at=now,
            ),
        ]
    )
    db.commit()
    http.sign_in(admin)

    resp = http.client.get("/api/v1/admin/workbench/ai-diagnostics?days=30")
    assert resp.status_code == 200, resp.text
    diag = resp.json()["data"]
    assert diag["days"] == 30
    assert diag["total_requests"] >= 5
    assert diag["succeeded"] >= 3
    assert diag["failed"] >= 2
    assert diag["avg_latency_ms"] is not None
    assert diag["p50_latency_ms"] is not None
    assert diag["p95_latency_ms"] is not None
    assert diag["p95_latency_ms"] >= diag["p50_latency_ms"]
    assert {e["error_code"] for e in diag["error_breakdown"]} >= {"TIMEOUT", "RATE_LIMIT"}
    assert diag["top_users"][0]["user_id"] == str(author.id)
    assert diag["top_projects"][0]["project_id"] == str(scope.project.id)
    assert len(diag["recent_failures"]) >= 2
    assert diag["summary_jobs"]["pending"] >= 1
    assert diag["summary_jobs"]["failed"] >= 1
    assert diag["summary_jobs"]["needs_human_review"] >= 1
    assert len(diag["hourly_24h"]) == 24
    assert sum(slot["requests"] for slot in diag["hourly_24h"]) >= 5

    filtered = http.client.get(
        f"/api/v1/admin/workbench/ai-diagnostics?days=7&user_id={member.id}&feature=review"
    )
    assert filtered.status_code == 200
    assert filtered.json()["data"]["total_requests"] == 1


def test_integrations_status_enforces_strict_privacy_masking(http, db, scope):
    admin = scope.users["admin"]
    author = scope.users["author"]
    now = datetime.now(UTC)

    gh1 = GithubRepoLink(
        id=uuid4(),
        project_id=scope.project.id,
        owner="must-se",
        repo="alpha",
        installation_id=1,
        default_branch="main",
        linked_at=now - timedelta(days=3),
        last_synced_at=now - timedelta(hours=2),
    )
    gh2 = GithubRepoLink(
        id=uuid4(),
        project_id=scope.other_project.id,
        owner="must-se",
        repo="beta-never",
        installation_id=2,
        default_branch="main",
        linked_at=now - timedelta(days=3),
        last_synced_at=None,
    )
    db.add_all([gh1, gh2])
    db.add(
        FeishuChatLink(
            id=uuid4(),
            project_id=scope.project.id,
            chat_id="oc_secret_chat_12345678",
            linked_at=now - timedelta(days=1),
        )
    )
    msg_row_id = uuid4()
    db.add(
        FeishuMessage(
            id=msg_row_id,
            project_id=scope.project.id,
            chat_id="oc_secret_chat_12345678",
            message_id="msg-priv-1",
            sender_type="user",
            msg_type="text",
            text="PRIVATE_TEAM_DISCUSSION_CONTENT",
            content_hash="h-priv",
            occurred_at=now - timedelta(hours=1),
            deleted=False,
            version_no=1,
            synced_at=now,
        )
    )
    db.flush()
    db.add(
        FeishuAttachment(
            id=uuid4(),
            message_row_id=msg_row_id,
            file_key="fk-1",
            kind="file",
            name="design.pdf",
            available=True,
        )
    )
    db.add(
        EmailChallenge(
            id=str(uuid4()),
            user_id=author.id,
            email="alice.private@student.must.edu.mo",
            email_normalized="alice.private@student.must.edu.mo",
            purpose="school_verify",
            code_hmac="h-email",
            send_status="failed",
            expires_at=now + timedelta(minutes=10),
            resend_available_at=now,
            created_at=now - timedelta(minutes=30),
        )
    )
    db.add(
        RateLimitCounter(
            bucket_key="login:ip:192.0.2.55",
            window_start=now - timedelta(minutes=20),
            count=19,
        )
    )
    db.commit()
    http.sign_in(admin)

    resp = http.client.get("/api/v1/admin/workbench/integrations")
    assert resp.status_code == 200, resp.text
    raw_text = resp.text
    assert "PRIVATE_TEAM_DISCUSSION_CONTENT" not in raw_text
    assert "oc_secret_chat_12345678" not in raw_text
    assert "alice.private" not in raw_text
    assert "192.0.2.55" not in raw_text

    data = resp.json()["data"]
    health_map = {item["repo_full_name"]: item["health"] for item in data["github"]["links"]}
    assert health_map["must-se/alpha"] == "healthy"
    assert health_map["must-se/beta-never"] == "never_synced"
    assert data["feishu"]["attachments_total"] >= 1
    assert data["feishu"]["links"][0]["chat_id_masked"].endswith("5678")
    assert data["email_delivery"]["challenges_failed_7d"] >= 1
    assert any(
        f["recipient_domain"] == "student.must.edu.mo"
        for f in data["email_delivery"]["recent_failures"]
    )
    assert any(
        b["bucket_prefix"] == "login" and b["total_hits"] >= 19
        for b in data["rate_limits"]["top_buckets"]
    )


def test_resolve_labels_and_course_metrics(http, db, scope):
    admin = scope.users["admin"]
    author = scope.users["author"]
    now = datetime.now(UTC)

    db.add(ProjectGroup(id=uuid4(), course_id=scope.course.id, name="Group Alpha"))
    db.add(
        GovCourseInvite(
            course_id=scope.course.id,
            code="INV-ALPHA-1",
            created_by=admin.id,
            created_at=now,
        )
    )
    db.commit()
    http.sign_in(admin)

    labels_resp = http.client.post(
        "/api/v1/admin/workbench/resolve-labels",
        json={
            "user_ids": [str(author.id), str(uuid4())],
            "course_ids": [str(scope.course.id), str(uuid4())],
            "project_ids": [str(scope.project.id), str(uuid4())],
        },
    )
    assert labels_resp.status_code == 200, labels_resp.text
    labels = labels_resp.json()["data"]
    assert labels["users"][str(author.id)]["name"] == author.name
    assert labels["courses"][str(scope.course.id)]["code"] == scope.course.code
    assert labels["projects"][str(scope.project.id)]["name"] == scope.project.name

    metrics_resp = http.client.post(
        "/api/v1/admin/workbench/courses/metrics",
        json={"course_ids": [str(scope.course.id)]},
    )
    assert metrics_resp.status_code == 200, metrics_resp.text
    course_metric = metrics_resp.json()["data"]["items"][str(scope.course.id)]
    assert course_metric["owner_name"] == scope.users["teacher"].name
    assert course_metric["group_count"] >= 1
    assert course_metric["project_count"] >= 1
    assert course_metric["has_active_invite"] is True


def test_c_admin_filters_and_bulk_import_dry_run_and_commit(http, db, scope):
    admin = scope.users["admin"]
    author = scope.users["author"]
    teacher = scope.users["teacher"]
    bind(db, author)
    now = datetime.now(UTC)

    db.add(
        TeacherApplication(
            id=str(uuid4()),
            user_id=author.id,
            application_version=1,
            snapshot={
                "name": "Special Teacher Applicant",
                "college": "Engineering",
                "schoolEmail": "special.teacher@must.edu.mo",
            },
            status="pending",
            created_at=now,
        )
    )
    db.commit()
    http.sign_in(admin)

    # Filter c-admin users by emailVerified and pageSize; verify createdAt/lastLoginAt exist
    verified_resp = http.client.get("/api/v1/c-admin/users?emailVerified=true&pageSize=1")
    assert verified_resp.status_code == 200, verified_resp.text
    verified_data = verified_resp.json()["data"]
    assert len(verified_data["items"]) <= 1
    assert "createdAt" in verified_data["items"][0]
    assert "lastLoginAt" in verified_data["items"][0]
    assert verified_data["items"][0]["schoolEmailVerified"] is True

    # Filter teacher applications with q & pageSize
    apps_resp = http.client.get(
        "/api/v1/c-admin/teacher-applications",
        params={"q": author.name, "pageSize": 5},
    )
    assert apps_resp.status_code == 200, apps_resp.text
    assert len(apps_resp.json()["data"]["items"]) == 1

    # Bulk import dryRun=True must persist ZERO users and detect duplicates/errors
    users_before = db.scalar(select(func.count()).select_from(User))
    dry_resp = http.client.post(
        "/api/v1/c-admin/users/bulk-import",
        json={
            "dryRun": True,
            "rows": [
                {
                    "identity": "student",
                    "name": "Batch Dry One",
                    "username": "batchdry01",
                    "studentId": "1240099001",
                    "schoolEmail": "1240099001@student.must.edu.mo",
                    "college": "Innovation Engineering",
                },
                {
                    "identity": "student",
                    "name": "Batch Dry Duplicate",
                    "username": "batchdry01",
                    "studentId": "1240099002",
                    "schoolEmail": "1240099002@student.must.edu.mo",
                    "college": "Innovation Engineering",
                },
                {
                    "identity": "student",
                    "name": "Bad Email",
                    "username": "badrow01",
                    "studentId": "1240099003",
                    "schoolEmail": "not-school-email@gmail.com",
                },
            ],
        },
    )
    assert dry_resp.status_code == 200, json.dumps(dry_resp.json(), ensure_ascii=False)
    dry_data = dry_resp.json()["data"]
    assert dry_data["dryRun"] is True
    assert dry_data["validCount"] == 1
    assert dry_data["createdCount"] == 0
    assert dry_data["invalidCount"] == 2
    assert db.scalar(select(func.count()).select_from(User)) == users_before

    # Bulk import dryRun=False isolates per-row errors and creates valid student & teacher accounts
    commit_resp = http.client.post(
        "/api/v1/c-admin/users/bulk-import",
        json={
            "dryRun": False,
            "rows": [
                {
                    "identity": "student",
                    "name": "Batch Real Student",
                    "username": "batchreal01",
                    "studentId": "1240099011",
                    "schoolEmail": "1240099011@student.must.edu.mo",
                    "college": "Innovation Engineering",
                },
                {
                    "identity": "teacher",
                    "name": "Batch Real Teacher",
                    "username": "batchteach01",
                    "schoolEmail": "batchteach01@must.edu.mo",
                    "college": "Business",
                    "submitForReview": True,
                },
                {
                    "identity": "student",
                    "name": "Existing Conflict",
                    "username": teacher.username or "existing-conflict",
                    "studentId": "1240099099",
                    "schoolEmail": "invalid-domain@example.com",
                },
            ],
        },
    )
    assert commit_resp.status_code == 200, commit_resp.text
    commit_data = commit_resp.json()["data"]
    assert commit_data["dryRun"] is False
    assert commit_data["createdCount"] == 2
    assert commit_data["invalidCount"] == 1
    assert db.scalar(select(func.count()).select_from(User)) == users_before + 2
