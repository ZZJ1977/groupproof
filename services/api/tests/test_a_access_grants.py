"""A 临时只读授权：目标可见性、回执、只读边界、到期与撤销。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import a_fixtures as fixtures
import pytest

from app.api.errors import ApiError
from app.modules.a import access_grants, github_sync, permissions
from app.modules.a.models import AccessGrant
from app.modules.c.governance_ports import AuthorizationReceipt, VisibleAccessTarget
from app.modules.c.governance_schemas import AccessScope

db = fixtures.db
scope = fixtures.scope

PORT = access_grants.DatabaseAuthorizationPort()


def project_scope(scope_fixture, project=None):
    project = project or scope_fixture.project
    return AccessScope(project_id=project.id, resource_type="project", resource_id=project.id)


def activate(
    db, scope_fixture, applicant, *, expires_in=timedelta(hours=1), command_id=None, request_id=None
):
    return PORT.activate(
        db,
        request_id=request_id or uuid4(),
        applicant_id=applicant.id,
        reviewer_id=scope_fixture.users["admin"].id,
        scope=project_scope(scope_fixture),
        expires_at=datetime.now(UTC) + expires_in,
        command_id=command_id or uuid4(),
    )


def test_visibility_is_for_course_staff_and_peers_of_public_projects_only(db, scope):
    target = project_scope(scope)
    peer = scope.users["peer"]  # 课程里另一个小组的学生
    assert PORT.visible_target(db, applicant_id=peer.id, scope=target) == VisibleAccessTarget(
        peer.id, target
    )
    assert PORT.visible_target(db, applicant_id=scope.users["teacher"].id, scope=target)
    with pytest.raises(ApiError) as outsider:
        PORT.visible_target(db, applicant_id=scope.users["outsider"].id, scope=target)
    with pytest.raises(ApiError) as missing:
        PORT.visible_target(
            db,
            applicant_id=peer.id,
            scope=AccessScope(
                project_id=(pid := uuid4()), resource_type="project", resource_id=pid
            ),
        )
    assert outsider.value.status_code == missing.value.status_code == 404
    assert outsider.value.code == missing.value.code  # 不暴露目标是否存在


def test_members_only_project_is_not_visible_to_peers(db, scope):
    scope.project.visibility = "members"
    db.flush()
    with pytest.raises(ApiError) as hidden:
        PORT.visible_target(db, applicant_id=scope.users["peer"].id, scope=project_scope(scope))
    assert hidden.value.status_code == 404


def test_activate_returns_exact_receipt_and_is_idempotent_per_command(db, scope):
    peer = scope.users["peer"]
    command, request = uuid4(), uuid4()
    expires = datetime.now(UTC) + timedelta(hours=2)
    kwargs = dict(
        request_id=request,
        applicant_id=peer.id,
        reviewer_id=scope.users["admin"].id,
        scope=project_scope(scope),
        expires_at=expires,
        command_id=command,
    )
    receipt = PORT.activate(db, **kwargs)
    assert isinstance(receipt, AuthorizationReceipt)
    assert (receipt.request_id, receipt.applicant_id, receipt.scope, receipt.expires_at) == (
        request,
        peer.id,
        project_scope(scope),
        expires,
    )
    assert PORT.activate(db, **kwargs) == receipt  # 同一个批准动作重复调用
    with pytest.raises(ApiError) as conflict:
        PORT.activate(db, **{**kwargs, "command_id": uuid4()})
    assert conflict.value.code == "ACCESS_GRANT_CONFLICT"
    with pytest.raises(ApiError) as past:
        PORT.activate(
            db,
            **{
                **kwargs,
                "request_id": uuid4(),
                "command_id": uuid4(),
                "expires_at": datetime.now(UTC) - timedelta(minutes=1),
            },
        )
    assert past.value.code == "ACCESS_EXPIRY_INVALID"


def test_grant_gives_read_only_access_not_membership(db, scope):
    peer, project = scope.users["peer"], scope.project
    with pytest.raises(ApiError) as before:
        github_sync.list_linked_repos(db, peer, project.id)
    assert before.value.status_code == 404
    activate(db, scope, peer)
    assert github_sync.list_linked_repos(db, peer, project.id) == []  # 现在能读
    with pytest.raises(ApiError) as write:
        permissions.require_project_member(db, peer, project.id, write=True)
    assert write.value.status_code == 403
    with pytest.raises(ApiError) as leader:
        permissions.require_project_leader(db, peer, project.id, write=False)
    assert leader.value.code == "PROJECT_LEADER_REQUIRED"
    with pytest.raises(ApiError) as bind:
        github_sync.link_repo(db, peer, project.id, "https://github.com/acme/demo", None)
    assert bind.value.status_code == 403
    with pytest.raises(ApiError) as other:
        github_sync.list_linked_repos(db, peer, scope.archived_project.id)  # 别的项目不受影响
    assert other.value.status_code == 404


def test_expired_grant_stops_working_immediately(db, scope):
    peer = scope.users["peer"]
    activate(db, scope, peer)
    grant = db.query(AccessGrant).one()
    assert access_grants.has_read_grant(db, peer.id, scope.project.id)
    grant.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.flush()
    assert not access_grants.has_read_grant(db, peer.id, scope.project.id)
    with pytest.raises(ApiError) as expired:
        github_sync.list_linked_repos(db, peer, scope.project.id)
    assert expired.value.status_code == 404


def test_revocation_stops_access_and_requires_admin_and_reason(db, scope):
    peer = scope.users["peer"]
    receipt = activate(db, scope, peer)
    with pytest.raises(ApiError) as not_admin:
        access_grants.revoke_grant(db, scope.users["teacher"], receipt.grant_id, "x")
    assert not_admin.value.status_code == 403
    with pytest.raises(ApiError) as no_reason:
        access_grants.revoke_grant(db, scope.users["admin"], receipt.grant_id, "  ")
    assert no_reason.value.code == "REASON_REQUIRED"
    grant = access_grants.revoke_grant(db, scope.users["admin"], receipt.grant_id, "误授权")
    assert grant.revoked_at is not None and grant.revoke_reason == "误授权"
    again = access_grants.revoke_grant(db, scope.users["admin"], receipt.grant_id, "再撤销")
    assert again.revoke_reason == "误授权"  # 重复撤销不改写
    with pytest.raises(ApiError):
        github_sync.list_linked_repos(db, peer, scope.project.id)
    with pytest.raises(ApiError) as missing:
        access_grants.revoke_grant(db, scope.users["admin"], uuid4(), "x")
    assert missing.value.status_code == 404


def test_task_scoped_grant_is_checked_per_resource_and_project_grant_covers_all(db, scope):
    peer = scope.users["peer"]
    task_id, other_task = uuid4(), uuid4()
    PORT.activate(
        db,
        request_id=uuid4(),
        applicant_id=peer.id,
        reviewer_id=scope.users["admin"].id,
        scope=AccessScope(project_id=scope.project.id, resource_type="task", resource_id=task_id),
        expires_at=datetime.now(UTC) + timedelta(hours=1),
        command_id=uuid4(),
    )
    project = scope.project.id
    assert access_grants.has_read_grant(db, peer.id, project, "task", task_id)
    assert not access_grants.has_read_grant(db, peer.id, project, "task", other_task)
    assert not access_grants.has_read_grant(db, peer.id, project)  # 任务授权不等于项目授权
    activate(db, scope, peer)
    assert access_grants.has_read_grant(db, peer.id, project, "task", other_task)
