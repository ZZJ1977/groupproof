"""Two authenticated admins racing to suspend one account against A's real inbox."""

import test_c_auth_verification_integration as identity_tests
import test_c_discussions_postgres as pg_tests
from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.config import get_settings
from app.auth.errors import AppError
from app.auth.guard import require_admin
from app.auth.models import AuthAuditEvent
from app.auth.routers.c_admin import DisableDecision, disable
from app.auth.services import sessions
from app.db.models import User
from app.modules.c.notification_delivery import get_notification_writer

inbox_pg_scope = pg_tests.inbox_pg_scope


def test_concurrent_suspensions_have_one_version_one_notice_and_one_audit(inbox_pg_scope):
    from app.modules.a.models import Notification

    engine, scope = inbox_pg_scope
    target_id = scope.users["member"].id
    requests = []
    with Session(engine) as db:
        for name in ("admin", "teacher"):
            actor = db.get(User, scope.users[name].id)
            actor.global_role = "admin"
            actor.username = f"c-auth-{actor.id.hex[:12]}"
            actor.student_id = None
            actor.requested_identity = None
            identity_tests.bind(db, actor)
            facts = sessions.current_facts(db, actor)
            assert facts["accountState"] == "active", facts
            issued = sessions.issue_session(db, actor, facts, auth_method="google")
            requests.append(
                Request(
                    {
                        "type": "http",
                        "method": "POST",
                        "headers": [
                            (
                                b"cookie",
                                f"{get_settings().session_cookie_name}={issued.raw_token}".encode(),
                            ),
                            (b"x-csrf-token", issued.record.csrf_token.encode()),
                        ],
                    }
                )
            )
        db.commit()
    command = DisableDecision(reason="Administrative suspension", expectedVersion=0)

    def attempt(db, request):
        context = require_admin(request, db)
        try:
            return disable(
                str(target_id), command, request, get_notification_writer(), context, db
            ).status_code
        except AppError as exc:
            db.rollback()
            return exc.status

    results = pg_tests.race(engine, [lambda db, req=req: attempt(db, req) for req in requests])
    assert sorted(results) == [200, 409]
    with Session(engine) as db:
        target = db.get(User, target_id)
        assert target.status == "disabled" and target.version == 1
        (notice,) = db.scalars(
            select(Notification).where(Notification.recipient_id == target_id)
        ).all()
        assert notice.description == command.reason
        assert notice.dedupe_key == f"c:account-disabled:{target_id}:1"
        assert (
            db.scalar(
                select(func.count())
                .select_from(AuthAuditEvent)
                .where(
                    AuthAuditEvent.target_user_id == str(target_id),
                    AuthAuditEvent.event_type == "user.disabled",
                )
            )
            == 1
        )
