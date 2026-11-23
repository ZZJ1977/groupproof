"""GroupProof-specific Admin Workbench service: single-call overview, 360 user profile,
SQL-aggregated AI FinOps diagnostics, proof-pipeline health, and label resolution.

Strict privacy & permission boundary:
- Every read requires an active administrator with a verified school email.
- Never reads or returns project descriptions, task descriptions, evidence descriptions,
  Feishu message bodies, GitHub file contents, passwords, or email verification codes.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID

from sqlalchemy import and_, case, func, literal_column, or_, select
from sqlalchemy.orm import Session, aliased

from app.api.errors import ApiError
from app.auth.models import (
    AuthAuditEvent,
    AuthIdentity,
    EmailChallenge,
    PasswordCredential,
    RateLimitCounter,
    SchoolEmailBinding,
    TeacherApplication,
    VerifiedGithubIdentity,
)
from app.auth.models import Session as AuthSession
from app.auth.services import audit as auth_audit
from app.auth.services import sessions as auth_sessions
from app.db.models import (
    Course,
    CourseMember,
    CourseStaff,
    Project,
    ProjectGroup,
    ProjectMember,
    Task,
    User,
)
from app.modules.a.audit import record_audit
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
from app.modules.c.auth_audit_service import require_auth_audit_admin
from app.modules.c.governance_common import current_actor, utc
from app.modules.c.governance_models import (
    AccessRequest,
    CourseInvite,
    GovernanceOutbox,
)
from app.modules.c.models import Evidence
from app.modules.c.school_email import school_email_binding_verified


def _format_cost(value: Decimal | float | int | None) -> str:
    if value is None:
        return "0"
    if isinstance(value, Decimal):
        text = format(value, "f")
    elif isinstance(value, float):
        text = f"{value:.6f}"
    else:
        return str(value)
    if "." in text:
        text = text.rstrip("0").rstrip(".") or "0"
    return text


def _costs_map(rows) -> dict[str, str]:
    totals: dict[str, Decimal] = {}
    for currency, amount in rows:
        if currency and amount is not None:
            totals[str(currency)] = totals.get(str(currency), Decimal(0)) + Decimal(str(amount))
    return {cur: _format_cost(val) for cur, val in sorted(totals.items())}


def _utc_day_expr(session: Session, col):
    dialect = session.get_bind().dialect.name
    if dialect == "postgresql":
        return func.to_char(
            func.timezone(literal_column("'UTC'"), col),
            literal_column("'YYYY-MM-DD'"),
        )
    return func.strftime("%Y-%m-%d", col)


def _latency_percentiles(
    session: Session, conditions: list, percentiles: tuple[float, ...]
) -> dict[float, int | None]:
    dialect = session.get_bind().dialect.name
    if dialect == "postgresql":
        exprs = [func.percentile_cont(p).within_group(AiUsageEvent.latency_ms) for p in percentiles]
        row = session.execute(
            select(*exprs).where(*conditions, AiUsageEvent.latency_ms.is_not(None))
        ).one_or_none()
        if row is None:
            return {p: None for p in percentiles}
        return {p: int(round(val)) if val is not None else None for p, val in zip(percentiles, row)}

    values = list(
        session.scalars(
            select(AiUsageEvent.latency_ms)
            .where(*conditions, AiUsageEvent.latency_ms.is_not(None))
            .order_by(AiUsageEvent.latency_ms.asc())
            .limit(10000)
        ).all()
    )
    if not values:
        return {p: None for p in percentiles}
    n = len(values)
    out: dict[float, int | None] = {}
    for p in percentiles:
        if n == 1:
            out[p] = int(values[0])
            continue
        pos = p * (n - 1)
        low = int(pos)
        high = min(low + 1, n - 1)
        frac = pos - low
        interp = values[low] * (1 - frac) + values[high] * frac
        out[p] = int(round(interp))
    return out


def _mask_chat_id(chat_id: str) -> str:
    cleaned = chat_id.strip()
    if len(cleaned) <= 10:
        return "***"
    return f"{cleaned[:6]}…{cleaned[-4:]}"


def _email_domain(email: str | None) -> str:
    if not email or "@" not in email:
        return "unknown"
    return email.rsplit("@", 1)[-1].lower()


def _daily_counts(
    session: Session, model_col, extra_where: list, since: datetime
) -> dict[str, int]:
    day_expr = _utc_day_expr(session, model_col)
    rows = session.execute(
        select(day_expr.label("day"), func.count().label("cnt"))
        .where(model_col >= since, *extra_where)
        .group_by(day_expr)
    ).all()
    return {str(day): int(cnt or 0) for day, cnt in rows if day}


def admin_overview(session: Session, user: User, *, now: datetime | None = None) -> dict:
    require_auth_audit_admin(session, user)
    now = utc(now or datetime.now(UTC))
    since_7d = datetime.combine(now.date() - timedelta(days=6), datetime.min.time(), UTC)
    since_24h = now - timedelta(hours=24)
    stale_cutoff = now - timedelta(hours=48)

    # 1. Users & identity verification aggregates
    user_row = session.execute(
        select(
            func.count(User.id).label("total"),
            func.sum(case((User.status == "active", 1), else_=0)).label("active"),
            func.sum(case((User.status == "pending", 1), else_=0)).label("pending"),
            func.sum(case((User.status == "disabled", 1), else_=0)).label("disabled"),
            func.sum(case((User.global_role == "student", 1), else_=0)).label("student"),
            func.sum(case((User.global_role == "teacher", 1), else_=0)).label("teacher"),
            func.sum(case((User.global_role == "ta", 1), else_=0)).label("ta"),
            func.sum(case((User.global_role == "admin", 1), else_=0)).label("admin"),
            func.sum(case((User.created_at >= since_7d, 1), else_=0)).label("new_last_7d"),
            func.sum(
                case(
                    (and_(User.last_login_at.is_not(None), User.last_login_at >= since_7d), 1),
                    else_=0,
                )
            ).label("active_last_7d"),
        )
    ).one()

    verified_email_count = (
        session.scalar(
            select(func.count())
            .select_from(SchoolEmailBinding)
            .where(SchoolEmailBinding.verified_at.is_not(None))
        )
        or 0
    )
    total_users = int(user_row.total or 0)
    google_linked = (
        session.scalar(
            select(func.count(func.distinct(AuthIdentity.user_id))).where(
                AuthIdentity.provider == "google"
            )
        )
        or 0
    )
    github_verified = session.scalar(select(func.count()).select_from(VerifiedGithubIdentity)) or 0

    # 2. Queues
    pending_teachers = (
        session.scalar(
            select(func.count())
            .select_from(TeacherApplication)
            .where(TeacherApplication.status == "pending")
        )
        or 0
    )
    pending_access = (
        session.scalar(
            select(func.count()).select_from(AccessRequest).where(AccessRequest.status == "pending")
        )
        or 0
    )
    active_grants = (
        session.scalar(
            select(func.count())
            .select_from(AccessGrant)
            .where(AccessGrant.revoked_at.is_(None), AccessGrant.expires_at > now)
        )
        or 0
    )
    undelivered_outbox = (
        session.scalar(
            select(func.count())
            .select_from(GovernanceOutbox)
            .where(GovernanceOutbox.delivered_at.is_(None))
        )
        or 0
    )

    # 3. Teaching & proof assets (counts only, zero private content)
    course_row = session.execute(
        select(
            func.count(Course.id).label("total"),
            func.sum(case((Course.status == "draft", 1), else_=0)).label("draft"),
            func.sum(case((Course.status == "active", 1), else_=0)).label("active"),
            func.sum(case((Course.status == "ended", 1), else_=0)).label("ended"),
        )
    ).one()
    groups_total = session.scalar(select(func.count()).select_from(ProjectGroup)) or 0
    project_row = session.execute(
        select(
            func.count(Project.id).label("total"),
            func.sum(case((Project.lifecycle == "active", 1), else_=0)).label("active"),
        )
    ).one()
    tasks_total = session.scalar(select(func.count()).select_from(Task)) or 0
    formal_evidences_total = (
        session.scalar(
            select(func.count()).select_from(Evidence).where(Evidence.status == "formal")
        )
        or 0
    )

    # 4. Proof pipeline health
    github_links = list(session.scalars(select(GithubRepoLink.last_synced_at)).all())
    github_synced_24h = sum(1 for ts in github_links if ts is not None and utc(ts) >= since_24h)
    github_stale_links = sum(1 for ts in github_links if ts is None or utc(ts) < stale_cutoff)
    feishu_chat_links = session.scalar(select(func.count()).select_from(FeishuChatLink)) or 0
    feishu_messages_7d = (
        session.scalar(
            select(func.count())
            .select_from(FeishuMessage)
            .where(FeishuMessage.occurred_at >= since_7d)
        )
        or 0
    )
    upload_row = session.execute(
        select(
            func.sum(case((UploadReceipt.status == "completed", 1), else_=0)).label("completed"),
            func.coalesce(
                func.sum(
                    case((UploadReceipt.status == "completed", UploadReceipt.size_bytes), else_=0)
                ),
                0,
            ).label("bytes"),
            func.sum(case((UploadReceipt.status == "rejected", 1), else_=0)).label("rejected"),
        )
    ).one()
    email_row = session.execute(
        select(
            func.count(EmailChallenge.id).label("total"),
            func.sum(case((EmailChallenge.send_status == "failed", 1), else_=0)).label("failed"),
        ).where(EmailChallenge.created_at >= since_7d)
    ).one()
    notif_email_failed = (
        session.scalar(
            select(func.count())
            .select_from(Notification)
            .where(Notification.created_at >= since_7d, Notification.email_status == "failed")
        )
        or 0
    )

    # 5. AI 7d diagnostics summary
    ai_where = [AiUsageEvent.occurred_at >= since_7d]
    ai_row = session.execute(
        select(
            func.count(AiUsageEvent.id).label("requests"),
            func.sum(case((AiUsageEvent.success.is_(True), 1), else_=0)).label("succeeded"),
            func.sum(case((AiUsageEvent.success.is_(False), 1), else_=0)).label("failed"),
            func.coalesce(func.sum(AiUsageEvent.input_tokens), 0).label("input_tokens"),
            func.coalesce(func.sum(AiUsageEvent.output_tokens), 0).label("output_tokens"),
            func.sum(
                case(
                    (or_(AiUsageEvent.cost.is_(None), AiUsageEvent.currency.is_(None)), 1),
                    else_=0,
                )
            ).label("unpriced"),
        ).where(*ai_where)
    ).one()
    ai_requests = int(ai_row.requests or 0)
    ai_succeeded = int(ai_row.succeeded or 0)
    ai_failed = int(ai_row.failed or 0)
    ai_costs = session.execute(
        select(AiUsageEvent.currency, func.sum(AiUsageEvent.cost))
        .where(*ai_where, AiUsageEvent.cost.is_not(None), AiUsageEvent.currency.is_not(None))
        .group_by(AiUsageEvent.currency)
    ).all()
    p95_map = _latency_percentiles(session, ai_where, (0.95,))
    err_code_expr = func.coalesce(AiUsageEvent.error_code, literal_column("'UNKNOWN_ERROR'"))
    err_rows = session.execute(
        select(
            err_code_expr.label("code"),
            func.count().label("cnt"),
            func.max(AiUsageEvent.occurred_at).label("last_seen"),
        )
        .where(*ai_where, AiUsageEvent.success.is_(False))
        .group_by(err_code_expr)
        .order_by(func.count().desc())
        .limit(5)
    ).all()

    # 6. 7-day activity series
    new_users_daily = _daily_counts(session, User.created_at, [], since_7d)
    audit_daily = _daily_counts(session, AuditEvent.occurred_at, [], since_7d)
    github_daily = _daily_counts(session, GithubActivity.occurred_at, [], since_7d)
    feishu_daily = _daily_counts(session, FeishuMessage.occurred_at, [], since_7d)
    ai_day_expr = _utc_day_expr(session, AiUsageEvent.occurred_at)
    ai_daily_rows = session.execute(
        select(
            ai_day_expr.label("day"),
            func.count().label("total"),
            func.sum(case((AiUsageEvent.success.is_(False), 1), else_=0)).label("failed"),
        )
        .where(AiUsageEvent.occurred_at >= since_7d)
        .group_by(ai_day_expr)
    ).all()
    ai_daily_total = {str(d): int(t or 0) for d, t, _ in ai_daily_rows if d}
    ai_daily_failed = {str(d): int(f or 0) for d, _, f in ai_daily_rows if d}

    activity_7d = []
    for offset in range(7):
        day_obj = since_7d.date() + timedelta(days=offset)
        key = day_obj.isoformat()
        activity_7d.append(
            {
                "date": day_obj,
                "new_users": new_users_daily.get(key, 0),
                "audit_events": audit_daily.get(key, 0),
                "ai_requests": ai_daily_total.get(key, 0),
                "ai_failed": ai_daily_failed.get(key, 0),
                "github_activities": github_daily.get(key, 0),
                "feishu_messages": feishu_daily.get(key, 0),
            }
        )

    # 7. Recent users
    recent_rows = session.execute(
        select(User, SchoolEmailBinding)
        .outerjoin(SchoolEmailBinding, SchoolEmailBinding.user_id == User.id)
        .order_by(User.created_at.desc(), User.id)
        .limit(6)
    ).all()
    recent_users = [
        {
            "id": u.id,
            "name": u.name or "未命名账号",
            "school_email": b.school_email if b else None,
            "school_email_verified": school_email_binding_verified(b),
            "role": u.global_role,
            "status": u.account_status,
            "college": u.college or "",
            "created_at": utc(u.created_at),
            "last_login_at": utc(u.last_login_at) if u.last_login_at else None,
        }
        for u, b in recent_rows
    ]

    # 8. Real system health probes
    ai_fail_rate = (ai_failed / ai_requests) if ai_requests else 0.0
    ai_health = (
        "degraded"
        if ai_requests >= 5 and ai_fail_rate >= 0.5
        else "warning"
        if ai_requests >= 3 and ai_fail_rate >= 0.2
        else "healthy"
    )
    email_failed_total = int(email_row.failed or 0) + int(notif_email_failed or 0)
    system_health = [
        {
            "key": "identity_db",
            "label": "统一身份与 PostgreSQL 主库",
            "status": "healthy",
            "detail": f"已连接 · 共 {total_users} 个账号，{verified_email_count} 个已验证学校邮箱",
        },
        {
            "key": "governance_outbox",
            "label": "治理事件 Outbox 队列",
            "status": "warning" if undelivered_outbox > 20 else "healthy",
            "detail": (
                f"待投递 {undelivered_outbox} 条" if undelivered_outbox else "队列清空，无积压事件"
            ),
        },
        {
            "key": "ai_gateway",
            "label": "OpenRouter AI 模型通道",
            "status": ai_health,
            "detail": (
                f"7 日共 {ai_requests} 次调用，成功率 {round((ai_succeeded / ai_requests) * 100)}%"
                if ai_requests
                else "最近 7 日暂无 AI 调用记录"
            ),
        },
        {
            "key": "proof_integrations",
            "label": "GitHub / 飞书 / 邮件链路",
            "status": "warning"
            if (github_stale_links > 0 or email_failed_total > 0)
            else "healthy",
            "detail": (
                f"GitHub 滞后 {github_stale_links} 个 · 7 日邮件失败 {email_failed_total} 次"
                if (github_stale_links or email_failed_total)
                else f"GitHub {len(github_links)} 仓 / 飞书 {feishu_chat_links} 群运行平稳"
            ),
        },
    ]

    return {
        "generated_at": now,
        "users": {
            "total": total_users,
            "active": int(user_row.active or 0),
            "pending": int(user_row.pending or 0),
            "disabled": int(user_row.disabled or 0),
            "verified_school_email": int(verified_email_count),
            "unverified_school_email": max(0, total_users - int(verified_email_count)),
            "google_linked": int(google_linked),
            "github_verified": int(github_verified),
            "by_role": {
                "student": int(user_row.student or 0),
                "teacher": int(user_row.teacher or 0),
                "ta": int(user_row.ta or 0),
                "admin": int(user_row.admin or 0),
            },
            "new_last_7d": int(user_row.new_last_7d or 0),
            "active_last_7d": int(user_row.active_last_7d or 0),
        },
        "queues": {
            "pending_teacher_applications": int(pending_teachers),
            "pending_access_requests": int(pending_access),
            "active_access_grants": int(active_grants),
            "undelivered_outbox": int(undelivered_outbox),
        },
        "teaching": {
            "courses_total": int(course_row.total or 0),
            "courses_draft": int(course_row.draft or 0),
            "courses_active": int(course_row.active or 0),
            "courses_ended": int(course_row.ended or 0),
            "groups_total": int(groups_total),
            "projects_total": int(project_row.total or 0),
            "projects_active": int(project_row.active or 0),
            "tasks_total": int(tasks_total),
            "formal_evidences_total": int(formal_evidences_total),
        },
        "proof_pipeline": {
            "github_repo_links": len(github_links),
            "github_synced_24h": github_synced_24h,
            "github_stale_links": github_stale_links,
            "feishu_chat_links": int(feishu_chat_links),
            "feishu_messages_7d": int(feishu_messages_7d),
            "upload_completed_count": int(upload_row.completed or 0),
            "upload_total_bytes": int(upload_row.bytes or 0),
            "upload_rejected_count": int(upload_row.rejected or 0),
            "email_challenges_7d": int(email_row.total or 0),
            "email_challenges_failed_7d": int(email_row.failed or 0),
            "notification_emails_failed_7d": int(notif_email_failed),
        },
        "ai_7d": {
            "requests": ai_requests,
            "succeeded": ai_succeeded,
            "failed": ai_failed,
            "success_rate": round((ai_succeeded / ai_requests) * 100, 1) if ai_requests else None,
            "input_tokens": int(ai_row.input_tokens or 0),
            "output_tokens": int(ai_row.output_tokens or 0),
            "p95_latency_ms": p95_map[0.95],
            "cost_by_currency": _costs_map(ai_costs),
            "unpriced_requests": int(ai_row.unpriced or 0),
            "top_errors": [
                {
                    "error_code": str(code),
                    "count": int(cnt or 0),
                    "last_seen_at": utc(last_seen) if last_seen else None,
                }
                for code, cnt, last_seen in err_rows
            ],
        },
        "activity_7d": activity_7d,
        "recent_users": recent_users,
        "system_health": system_health,
    }


def user_profile_360(
    session: Session, actor_user: User, target_user_id: UUID, *, now: datetime | None = None
) -> dict:
    require_auth_audit_admin(session, actor_user)
    now = utc(now or datetime.now(UTC))
    target = session.scalar(
        select(User).where(User.id == target_user_id).execution_options(populate_existing=True)
    )
    if target is None:
        raise ApiError(404, "USER_NOT_FOUND", "User does not exist.")

    binding = session.get(SchoolEmailBinding, target.id, populate_existing=True)
    credential = session.get(PasswordCredential, target.id, populate_existing=True)
    google_identity = session.scalar(
        select(AuthIdentity)
        .where(AuthIdentity.user_id == target.id, AuthIdentity.provider == "google")
        .limit(1)
    )
    github_identity = session.get(VerifiedGithubIdentity, target.id, populate_existing=True)

    session_rows = list(
        session.scalars(
            select(AuthSession)
            .where(AuthSession.user_id == target.id)
            .order_by(AuthSession.created_at.desc())
            .limit(8)
        ).all()
    )
    all_unrevoked = list(
        session.scalars(
            select(AuthSession).where(
                AuthSession.user_id == target.id, AuthSession.revoked_at.is_(None)
            )
        ).all()
    )
    active_session_count = sum(
        1 for s in all_unrevoked if utc(s.expires_at) > now and utc(s.absolute_expires_at) > now
    )

    owned_courses = (
        session.scalar(select(func.count()).select_from(Course).where(Course.owner_id == target.id))
        or 0
    )
    enrolled_courses = (
        session.scalar(
            select(func.count())
            .select_from(CourseMember)
            .where(
                CourseMember.user_id == target.id,
                CourseMember.status == "active",
                CourseMember.left_at.is_(None),
            )
        )
        or 0
    )
    staff_courses = (
        session.scalar(
            select(func.count())
            .select_from(CourseStaff)
            .where(CourseStaff.user_id == target.id, CourseStaff.left_at.is_(None))
        )
        or 0
    )
    member_projects = (
        session.scalar(
            select(func.count())
            .select_from(ProjectMember)
            .where(ProjectMember.user_id == target.id, ProjectMember.left_at.is_(None))
        )
        or 0
    )
    active_access_grants = (
        session.scalar(
            select(func.count())
            .select_from(AccessGrant)
            .where(
                AccessGrant.applicant_id == target.id,
                AccessGrant.revoked_at.is_(None),
                AccessGrant.expires_at > now,
            )
        )
        or 0
    )

    since_30d = now - timedelta(days=30)
    ai_row = session.execute(
        select(
            func.count(AiUsageEvent.id).label("requests"),
            func.sum(case((AiUsageEvent.success.is_(False), 1), else_=0)).label("failed"),
            func.coalesce(func.sum(AiUsageEvent.input_tokens), 0).label("input_tokens"),
            func.coalesce(func.sum(AiUsageEvent.output_tokens), 0).label("output_tokens"),
        ).where(AiUsageEvent.user_id == target.id, AiUsageEvent.occurred_at >= since_30d)
    ).one()
    ai_costs = session.execute(
        select(AiUsageEvent.currency, func.sum(AiUsageEvent.cost))
        .where(
            AiUsageEvent.user_id == target.id,
            AiUsageEvent.occurred_at >= since_30d,
            AiUsageEvent.cost.is_not(None),
            AiUsageEvent.currency.is_not(None),
        )
        .group_by(AiUsageEvent.currency)
    ).all()

    target_str = str(target.id)
    auth_events = list(
        session.scalars(
            select(AuthAuditEvent)
            .where(
                or_(
                    AuthAuditEvent.target_user_id == target_str,
                    AuthAuditEvent.actor_id == target_str,
                )
            )
            .order_by(AuthAuditEvent.created_at.desc(), AuthAuditEvent.id.asc())
            .limit(8)
        ).all()
    )

    return {
        "user_id": target.id,
        "name": target.name or "",
        "username": target.username,
        "student_id": target.student_id,
        "college": target.college or "",
        "global_role": target.global_role,
        "status": target.account_status,
        "created_at": utc(target.created_at),
        "last_login_at": utc(target.last_login_at) if target.last_login_at else None,
        "disabled_at": utc(target.disabled_at) if target.disabled_at else None,
        "disabled_reason": target.disabled_reason,
        "verification": {
            "school_email": binding.school_email if binding else None,
            "school_email_verified": school_email_binding_verified(binding),
            "school_email_verified_at": (
                utc(binding.verified_at) if binding and binding.verified_at else None
            ),
            "pending_school_email": binding.pending_school_email if binding else None,
            "has_password": credential is not None,
            "login_email_verified": bool(
                credential is not None and credential.login_email_verified_at is not None
            ),
            "google_linked": google_identity is not None,
            "google_email": google_identity.google_email if google_identity else None,
            "github_verified": github_identity is not None,
            "github_login": github_identity.login if github_identity else None,
        },
        "sessions": {
            "active_count": active_session_count,
            "recent": [
                {
                    "id": s.id,
                    "scope": s.scope,
                    "auth_method": s.auth_method,
                    "created_at": utc(s.created_at),
                    "last_seen_at": utc(s.last_seen_at),
                    "expires_at": utc(s.expires_at),
                    "revoked_at": utc(s.revoked_at) if s.revoked_at else None,
                    "revoke_reason": s.revoke_reason,
                }
                for s in session_rows
            ],
        },
        "teaching_summary": {
            "owned_courses": int(owned_courses),
            "enrolled_courses": int(enrolled_courses),
            "staff_courses": int(staff_courses),
            "member_projects": int(member_projects),
            "active_access_grants": int(active_access_grants),
        },
        "ai_30d": {
            "requests": int(ai_row.requests or 0),
            "failed": int(ai_row.failed or 0),
            "input_tokens": int(ai_row.input_tokens or 0),
            "output_tokens": int(ai_row.output_tokens or 0),
            "cost_by_currency": _costs_map(ai_costs),
        },
        "recent_auth_events": [
            {
                "id": ev.id,
                "event_type": ev.event_type,
                "result": ev.result,
                "occurred_at": utc(ev.created_at),
            }
            for ev in auth_events
        ],
    }


def revoke_user_sessions(
    session: Session, actor_user: User, target_user_id: UUID, reason: str, request=None
) -> dict:
    actor = current_actor(session, actor_user, admin=True, write=True)
    if target_user_id == actor.id:
        raise ApiError(
            403, "CANNOT_REVOKE_SELF", "Cannot force-revoke your own active admin sessions."
        )
    target = session.scalar(
        select(User)
        .where(User.id == target_user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if target is None:
        raise ApiError(404, "USER_NOT_FOUND", "User does not exist.")
    active_count = (
        session.scalar(
            select(func.count())
            .select_from(AuthSession)
            .where(AuthSession.user_id == target.id, AuthSession.revoked_at.is_(None))
        )
        or 0
    )
    auth_sessions.revoke_all_for_user(session, target.id, "admin_forced_logout")
    target.auth_version += 1
    auth_audit.record(
        session,
        "auth.logout",
        actor_id=actor.id,
        target_user_id=target.id,
        request_id=getattr(getattr(request, "state", None), "request_id", None),
        changed_fields=["session"],
    )
    record_audit(
        session,
        actor=actor,
        action="admin.user.sessions_revoked",
        target=("user", target.id),
        reason=reason,
        request=request,
        after={"revoked_count": int(active_count), "auth_version": target.auth_version},
    )
    session.flush()
    return {
        "user_id": target.id,
        "revoked_count": int(active_count),
        "auth_version": target.auth_version,
    }


def list_access_grants(
    session: Session,
    user: User,
    *,
    page: int = 1,
    page_size: int = 10,
    status: str = "active",
    now: datetime | None = None,
) -> dict:
    require_auth_audit_admin(session, user)
    now = utc(now or datetime.now(UTC))
    applicant = aliased(User)
    applicant_binding = aliased(SchoolEmailBinding)
    reviewer = aliased(User)
    revoker = aliased(User)

    conditions = []
    if status == "active":
        conditions.extend([AccessGrant.revoked_at.is_(None), AccessGrant.expires_at > now])
    elif status == "expired":
        conditions.extend([AccessGrant.revoked_at.is_(None), AccessGrant.expires_at <= now])
    elif status == "revoked":
        conditions.append(AccessGrant.revoked_at.is_not(None))

    base = (
        select(
            AccessGrant,
            applicant.name.label("applicant_name"),
            applicant_binding.school_email.label("applicant_email"),
            reviewer.name.label("reviewer_name"),
            revoker.name.label("revoker_name"),
            Project.name.label("project_name"),
            Course.code.label("course_code"),
        )
        .join(applicant, applicant.id == AccessGrant.applicant_id)
        .outerjoin(applicant_binding, applicant_binding.user_id == applicant.id)
        .outerjoin(reviewer, reviewer.id == AccessGrant.reviewer_id)
        .outerjoin(revoker, revoker.id == AccessGrant.revoked_by_id)
        .join(Project, Project.id == AccessGrant.project_id)
        .outerjoin(Course, Course.id == Project.course_id)
        .where(*conditions)
    )
    total = session.scalar(select(func.count()).select_from(AccessGrant).where(*conditions)) or 0
    rows = session.execute(
        base.order_by(AccessGrant.created_at.desc(), AccessGrant.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    items = []
    for grant, app_name, app_email, rev_name, revoker_name, proj_name, course_code in rows:
        exp = utc(grant.expires_at)
        state = "revoked" if grant.revoked_at is not None else "active" if exp > now else "expired"
        items.append(
            {
                "id": grant.id,
                "request_id": grant.request_id,
                "applicant_id": grant.applicant_id,
                "applicant_name": app_name or str(grant.applicant_id),
                "applicant_email": app_email,
                "reviewer_id": grant.reviewer_id,
                "reviewer_name": rev_name,
                "project_id": grant.project_id,
                "project_name": proj_name or str(grant.project_id),
                "course_code": course_code,
                "resource_type": grant.resource_type,
                "resource_id": grant.resource_id,
                "created_at": utc(grant.created_at),
                "expires_at": exp,
                "revoked_at": utc(grant.revoked_at) if grant.revoked_at else None,
                "revoked_by_name": revoker_name,
                "revoke_reason": grant.revoke_reason,
                "state": state,
            }
        )
    return {"items": items, "total": int(total), "page": page, "page_size": page_size}


def ai_diagnostics(
    session: Session,
    user: User,
    *,
    days: int = 7,
    user_id: UUID | None = None,
    feature: str | None = None,
    model: str | None = None,
    now: datetime | None = None,
) -> dict:
    require_auth_audit_admin(session, user)
    until = utc(now or datetime.now(UTC))
    since = datetime.combine(until.date() - timedelta(days=days - 1), datetime.min.time(), UTC)
    conditions = [AiUsageEvent.occurred_at >= since, AiUsageEvent.occurred_at < until]
    if user_id is not None:
        conditions.append(AiUsageEvent.user_id == user_id)
    if feature:
        conditions.append(AiUsageEvent.feature == feature)
    if model:
        conditions.append(AiUsageEvent.model == model)

    summary = session.execute(
        select(
            func.count(AiUsageEvent.id).label("total"),
            func.sum(case((AiUsageEvent.success.is_(True), 1), else_=0)).label("succeeded"),
            func.sum(case((AiUsageEvent.success.is_(False), 1), else_=0)).label("failed"),
            func.avg(AiUsageEvent.latency_ms).label("avg_latency"),
        ).where(*conditions)
    ).one()
    pct = _latency_percentiles(session, conditions, (0.5, 0.95))

    err_code_expr = func.coalesce(AiUsageEvent.error_code, literal_column("'UNKNOWN_ERROR'"))
    error_rows = session.execute(
        select(
            err_code_expr.label("code"),
            func.count().label("cnt"),
            func.max(AiUsageEvent.occurred_at).label("last_seen"),
        )
        .where(*conditions, AiUsageEvent.success.is_(False))
        .group_by(err_code_expr)
        .order_by(func.count().desc())
        .limit(12)
    ).all()

    token_sum = func.coalesce(func.sum(AiUsageEvent.input_tokens), 0) + func.coalesce(
        func.sum(AiUsageEvent.output_tokens), 0
    )

    top_user_rows = session.execute(
        select(
            AiUsageEvent.user_id,
            User.name,
            User.global_role,
            func.count().label("requests"),
            func.sum(case((AiUsageEvent.success.is_(False), 1), else_=0)).label("failed"),
            token_sum.label("total_tokens"),
        )
        .outerjoin(User, User.id == AiUsageEvent.user_id)
        .where(*conditions, AiUsageEvent.user_id.is_not(None))
        .group_by(AiUsageEvent.user_id, User.name, User.global_role)
        .order_by(token_sum.desc(), func.count().desc())
        .limit(8)
    ).all()
    user_cost_rows = session.execute(
        select(AiUsageEvent.user_id, AiUsageEvent.currency, func.sum(AiUsageEvent.cost))
        .where(
            *conditions,
            AiUsageEvent.user_id.is_not(None),
            AiUsageEvent.cost.is_not(None),
            AiUsageEvent.currency.is_not(None),
        )
        .group_by(AiUsageEvent.user_id, AiUsageEvent.currency)
    ).all()
    user_costs_by_id: dict[UUID, list] = defaultdict(list)
    for uid, cur, amt in user_cost_rows:
        if uid is not None:
            user_costs_by_id[uid].append((cur, amt))

    top_project_rows = session.execute(
        select(
            AiUsageEvent.project_id,
            Project.name,
            Course.code,
            func.count().label("requests"),
            func.sum(case((AiUsageEvent.success.is_(False), 1), else_=0)).label("failed"),
            token_sum.label("total_tokens"),
        )
        .outerjoin(Project, Project.id == AiUsageEvent.project_id)
        .outerjoin(Course, Course.id == Project.course_id)
        .where(*conditions, AiUsageEvent.project_id.is_not(None))
        .group_by(AiUsageEvent.project_id, Project.name, Course.code)
        .order_by(token_sum.desc(), func.count().desc())
        .limit(8)
    ).all()
    project_cost_rows = session.execute(
        select(AiUsageEvent.project_id, AiUsageEvent.currency, func.sum(AiUsageEvent.cost))
        .where(
            *conditions,
            AiUsageEvent.project_id.is_not(None),
            AiUsageEvent.cost.is_not(None),
            AiUsageEvent.currency.is_not(None),
        )
        .group_by(AiUsageEvent.project_id, AiUsageEvent.currency)
    ).all()
    project_costs_by_id: dict[UUID, list] = defaultdict(list)
    for pid, cur, amt in project_cost_rows:
        if pid is not None:
            project_costs_by_id[pid].append((cur, amt))

    failure_rows = session.execute(
        select(AiUsageEvent, User.name.label("user_name"), Project.name.label("project_name"))
        .outerjoin(User, User.id == AiUsageEvent.user_id)
        .outerjoin(Project, Project.id == AiUsageEvent.project_id)
        .where(*conditions, AiUsageEvent.success.is_(False))
        .order_by(AiUsageEvent.occurred_at.desc(), AiUsageEvent.id)
        .limit(15)
    ).all()

    summary_jobs_row = session.execute(
        select(
            func.count(ActivitySummary.id).label("total"),
            func.sum(case((ActivitySummary.status == "pending", 1), else_=0)).label("pending"),
            func.sum(case((ActivitySummary.status == "failed", 1), else_=0)).label("failed"),
            func.sum(case((ActivitySummary.needs_human_review.is_(True), 1), else_=0)).label(
                "needs_review"
            ),
        )
    ).one()

    return {
        "days": days,
        "since": since,
        "until": until,
        "total_requests": int(summary.total or 0),
        "succeeded": int(summary.succeeded or 0),
        "failed": int(summary.failed or 0),
        "avg_latency_ms": (
            int(round(summary.avg_latency)) if summary.avg_latency is not None else None
        ),
        "p50_latency_ms": pct[0.5],
        "p95_latency_ms": pct[0.95],
        "error_breakdown": [
            {
                "error_code": str(code),
                "count": int(cnt or 0),
                "last_seen_at": utc(last_seen) if last_seen else None,
            }
            for code, cnt, last_seen in error_rows
        ],
        "top_users": [
            {
                "user_id": uid,
                "user_name": uname or (str(uid) if uid else "系统/匿名"),
                "role": urole,
                "requests": int(reqs or 0),
                "failed": int(fails or 0),
                "total_tokens": int(toks or 0),
                "cost_by_currency": _costs_map(user_costs_by_id.get(uid, [])) if uid else {},
            }
            for uid, uname, urole, reqs, fails, toks in top_user_rows
        ],
        "top_projects": [
            {
                "project_id": pid,
                "project_name": pname or (str(pid) if pid else "未关联项目"),
                "course_code": ccode,
                "requests": int(reqs or 0),
                "failed": int(fails or 0),
                "total_tokens": int(toks or 0),
                "cost_by_currency": _costs_map(project_costs_by_id.get(pid, [])) if pid else {},
            }
            for pid, pname, ccode, reqs, fails, toks in top_project_rows
        ],
        "recent_failures": [
            {
                "id": ev.id,
                "occurred_at": utc(ev.occurred_at),
                "user_id": ev.user_id,
                "user_name": uname or (str(ev.user_id) if ev.user_id else "系统/未记录"),
                "project_id": ev.project_id,
                "project_name": pname,
                "feature": ev.feature,
                "model": ev.model,
                "error_code": ev.error_code,
                "latency_ms": ev.latency_ms,
            }
            for ev, uname, pname in failure_rows
        ],
        "summary_jobs": {
            "total": int(summary_jobs_row.total or 0),
            "pending": int(summary_jobs_row.pending or 0),
            "failed": int(summary_jobs_row.failed or 0),
            "needs_human_review": int(summary_jobs_row.needs_review or 0),
        },
    }


def integrations_status(session: Session, user: User, *, now: datetime | None = None) -> dict:
    require_auth_audit_admin(session, user)
    now = utc(now or datetime.now(UTC))
    since_24h = now - timedelta(hours=24)
    stale_cutoff = now - timedelta(hours=48)
    since_7d = now - timedelta(days=7)

    # 1. GitHub links & activity counts
    gh_rows = session.execute(
        select(
            GithubRepoLink,
            Project.name.label("project_name"),
            Course.code.label("course_code"),
        )
        .join(Project, Project.id == GithubRepoLink.project_id)
        .outerjoin(Course, Course.id == Project.course_id)
        .order_by(GithubRepoLink.linked_at.desc())
        .limit(50)
    ).all()
    gh_counts = {
        link_id: int(cnt or 0)
        for link_id, cnt in session.execute(
            select(GithubActivity.link_id, func.count())
            .where(GithubActivity.deleted.is_(False))
            .group_by(GithubActivity.link_id)
        ).all()
    }
    all_gh_sync_times = list(session.scalars(select(GithubRepoLink.last_synced_at)).all())
    gh_synced_24h = sum(1 for ts in all_gh_sync_times if ts is not None and utc(ts) >= since_24h)
    gh_never = sum(1 for ts in all_gh_sync_times if ts is None)
    gh_stale = sum(1 for ts in all_gh_sync_times if ts is not None and utc(ts) < stale_cutoff)
    gh_activities_7d = (
        session.scalar(
            select(func.count())
            .select_from(GithubActivity)
            .where(GithubActivity.occurred_at >= since_7d, GithubActivity.deleted.is_(False))
        )
        or 0
    )
    gh_verified_identities = (
        session.scalar(select(func.count()).select_from(VerifiedGithubIdentity)) or 0
    )

    gh_links_dto = []
    for link, pname, ccode in gh_rows:
        synced = utc(link.last_synced_at) if link.last_synced_at else None
        health = (
            "never_synced" if synced is None else "stale" if synced < stale_cutoff else "healthy"
        )
        gh_links_dto.append(
            {
                "id": link.id,
                "project_id": link.project_id,
                "project_name": pname or str(link.project_id),
                "course_code": ccode,
                "repo_full_name": f"{link.owner}/{link.repo}",
                "default_branch": link.default_branch,
                "last_synced_at": synced,
                "activity_count": gh_counts.get(link.id, 0),
                "health": health,
            }
        )

    # 2. Feishu links & message metadata (never read message body)
    fs_rows = session.execute(
        select(
            FeishuChatLink,
            Project.name.label("project_name"),
            Course.code.label("course_code"),
        )
        .join(Project, Project.id == FeishuChatLink.project_id)
        .outerjoin(Course, Course.id == Project.course_id)
        .order_by(FeishuChatLink.linked_at.desc())
        .limit(50)
    ).all()
    fs_stats = {
        (pid, cid): (int(cnt or 0), utc(last_at) if last_at else None)
        for pid, cid, cnt, last_at in session.execute(
            select(
                FeishuMessage.project_id,
                FeishuMessage.chat_id,
                func.count(),
                func.max(FeishuMessage.occurred_at),
            ).group_by(FeishuMessage.project_id, FeishuMessage.chat_id)
        ).all()
    }
    fs_msg_row = session.execute(
        select(
            func.count(FeishuMessage.id).label("total"),
            func.sum(case((FeishuMessage.deleted.is_(True), 1), else_=0)).label("deleted"),
        ).where(FeishuMessage.occurred_at >= since_7d)
    ).one()
    fs_attachments = session.scalar(select(func.count()).select_from(FeishuAttachment)) or 0
    fs_total_links = session.scalar(select(func.count()).select_from(FeishuChatLink)) or 0

    fs_links_dto = []
    for link, pname, ccode in fs_rows:
        msg_cnt, last_msg_at = fs_stats.get((link.project_id, link.chat_id), (0, None))
        fs_links_dto.append(
            {
                "id": link.id,
                "project_id": link.project_id,
                "project_name": pname or str(link.project_id),
                "course_code": ccode,
                "chat_id_masked": _mask_chat_id(link.chat_id),
                "linked_at": utc(link.linked_at),
                "message_count": msg_cnt,
                "last_message_at": last_msg_at,
            }
        )

    # 3. Email delivery (domain-only failure visibility)
    ch_row = session.execute(
        select(
            func.count(EmailChallenge.id).label("total"),
            func.sum(case((EmailChallenge.send_status == "accepted", 1), else_=0)).label(
                "accepted"
            ),
            func.sum(case((EmailChallenge.send_status == "captured", 1), else_=0)).label(
                "captured"
            ),
            func.sum(case((EmailChallenge.send_status == "failed", 1), else_=0)).label("failed"),
        ).where(EmailChallenge.created_at >= since_7d)
    ).one()
    notif_pending = (
        session.scalar(
            select(func.count())
            .select_from(Notification)
            .where(Notification.email_status == "pending")
        )
        or 0
    )
    notif_row = session.execute(
        select(
            func.sum(case((Notification.email_status == "sent", 1), else_=0)).label("sent"),
            func.sum(case((Notification.email_status == "failed", 1), else_=0)).label("failed"),
        ).where(Notification.created_at >= since_7d)
    ).one()

    failed_challenges = session.scalars(
        select(EmailChallenge)
        .where(EmailChallenge.created_at >= since_7d, EmailChallenge.send_status == "failed")
        .order_by(EmailChallenge.created_at.desc())
        .limit(8)
    ).all()
    failed_notifs = session.execute(
        select(Notification, SchoolEmailBinding.school_email)
        .outerjoin(SchoolEmailBinding, SchoolEmailBinding.user_id == Notification.recipient_id)
        .where(Notification.created_at >= since_7d, Notification.email_status == "failed")
        .order_by(Notification.created_at.desc())
        .limit(8)
    ).all()
    recent_email_failures = [
        {
            "id": ch.id,
            "kind": "challenge",
            "purpose": ch.purpose,
            "recipient_domain": _email_domain(ch.email_normalized),
            "status": ch.send_status,
            "occurred_at": utc(ch.created_at),
        }
        for ch in failed_challenges
    ] + [
        {
            "id": str(n.id),
            "kind": "notification",
            "purpose": n.category,
            "recipient_domain": _email_domain(semail),
            "status": n.email_status,
            "occurred_at": utc(n.created_at),
        }
        for n, semail in failed_notifs
    ]
    recent_email_failures.sort(key=lambda item: item["occurred_at"], reverse=True)

    # 4. Storage, evidence & outbox
    up_row = session.execute(
        select(
            func.sum(case((UploadReceipt.status == "completed", 1), else_=0)).label("completed"),
            func.sum(case((UploadReceipt.status == "pending", 1), else_=0)).label("pending"),
            func.sum(case((UploadReceipt.status == "rejected", 1), else_=0)).label("rejected"),
            func.coalesce(
                func.sum(
                    case((UploadReceipt.status == "completed", UploadReceipt.size_bytes), else_=0)
                ),
                0,
            ).label("total_bytes"),
        )
    ).one()
    ev_row = session.execute(
        select(
            func.count(Evidence.id).label("total"),
            func.sum(case((Evidence.status == "formal", 1), else_=0)).label("formal"),
            func.sum(case((Evidence.status == "pending_confirmation", 1), else_=0)).label(
                "pending_confirmation"
            ),
            func.sum(case((Evidence.status.in_(("withdrawn", "void")), 1), else_=0)).label(
                "withdrawn_or_void"
            ),
        )
    ).one()
    summary_failed = (
        session.scalar(
            select(func.count())
            .select_from(ActivitySummary)
            .where(ActivitySummary.status == "failed")
        )
        or 0
    )
    outbox_pending = (
        session.scalar(
            select(func.count())
            .select_from(GovernanceOutbox)
            .where(GovernanceOutbox.delivered_at.is_(None))
        )
        or 0
    )

    # 5. Rate limit buckets (24h, prefix masked to avoid echoing raw IP or email)
    rl_rows = list(
        session.scalars(
            select(RateLimitCounter).where(RateLimitCounter.window_start >= since_24h)
        ).all()
    )
    rl_grouped: dict[str, list] = defaultdict(list)
    for rl in rl_rows:
        prefix = rl.bucket_key.split(":", 1)[0][:40]
        rl_grouped[prefix].append(rl)
    top_buckets = sorted(
        (
            {
                "bucket_prefix": prefix,
                "total_hits": sum(int(item.count or 0) for item in items),
                "latest_window": max(utc(item.window_start) for item in items),
            }
            for prefix, items in rl_grouped.items()
        ),
        key=lambda item: item["total_hits"],
        reverse=True,
    )[:8]

    return {
        "generated_at": now,
        "github": {
            "total_links": len(all_gh_sync_times),
            "synced_24h": gh_synced_24h,
            "stale_over_48h": gh_stale,
            "never_synced": gh_never,
            "activities_7d": int(gh_activities_7d),
            "verified_identities": int(gh_verified_identities),
            "links": gh_links_dto,
        },
        "feishu": {
            "total_links": int(fs_total_links),
            "messages_7d": int(fs_msg_row.total or 0),
            "deleted_messages_7d": int(fs_msg_row.deleted or 0),
            "attachments_total": int(fs_attachments),
            "links": fs_links_dto,
        },
        "email_delivery": {
            "challenges_7d": int(ch_row.total or 0),
            "challenges_accepted_7d": int(ch_row.accepted or 0),
            "challenges_captured_7d": int(ch_row.captured or 0),
            "challenges_failed_7d": int(ch_row.failed or 0),
            "notifications_email_pending": int(notif_pending),
            "notifications_email_sent_7d": int(notif_row.sent or 0),
            "notifications_email_failed_7d": int(notif_row.failed or 0),
            "recent_failures": recent_email_failures[:10],
        },
        "storage_and_evidence": {
            "upload_completed": int(up_row.completed or 0),
            "upload_pending": int(up_row.pending or 0),
            "upload_rejected": int(up_row.rejected or 0),
            "total_bytes": int(up_row.total_bytes or 0),
            "evidence_total": int(ev_row.total or 0),
            "evidence_formal": int(ev_row.formal or 0),
            "evidence_pending_confirmation": int(ev_row.pending_confirmation or 0),
            "evidence_withdrawn_or_void": int(ev_row.withdrawn_or_void or 0),
            "activity_summaries_failed": int(summary_failed),
            "outbox_pending": int(outbox_pending),
        },
        "rate_limits": {
            "active_buckets_24h": len(rl_rows),
            "top_buckets": top_buckets,
        },
    }


def resolve_labels(
    session: Session,
    user: User,
    *,
    user_ids: list[UUID],
    course_ids: list[UUID],
    project_ids: list[UUID],
) -> dict:
    require_auth_audit_admin(session, user)
    users_map: dict[str, dict] = {}
    if user_ids:
        rows = session.scalars(select(User).where(User.id.in_(set(user_ids)))).all()
        for row in rows:
            users_map[str(row.id)] = {
                "id": row.id,
                "name": row.name or row.username or str(row.id),
                "role": row.global_role,
                "student_id": row.student_id,
                "college": row.college,
            }

    courses_map: dict[str, dict] = {}
    if course_ids:
        rows = session.scalars(select(Course).where(Course.id.in_(set(course_ids)))).all()
        for row in rows:
            courses_map[str(row.id)] = {
                "id": row.id,
                "code": row.code,
                "name": row.name,
                "semester": row.semester,
                "status": row.status,
            }

    projects_map: dict[str, dict] = {}
    if project_ids:
        rows = session.execute(
            select(Project, Course.code)
            .outerjoin(Course, Course.id == Project.course_id)
            .where(Project.id.in_(set(project_ids)))
        ).all()
        for proj, ccode in rows:
            projects_map[str(proj.id)] = {
                "id": proj.id,
                "name": proj.name,
                "course_id": proj.course_id,
                "course_code": ccode,
                "lifecycle": proj.lifecycle,
            }

    return {"users": users_map, "courses": courses_map, "projects": projects_map}


def course_metrics(session: Session, user: User, *, course_ids: list[UUID]) -> dict:
    require_auth_audit_admin(session, user)
    ids = list(dict.fromkeys(course_ids))
    courses = session.execute(
        select(Course, User.name, SchoolEmailBinding.school_email)
        .join(User, User.id == Course.owner_id)
        .outerjoin(SchoolEmailBinding, SchoolEmailBinding.user_id == User.id)
        .where(Course.id.in_(ids))
    ).all()

    members = {
        cid: int(cnt or 0)
        for cid, cnt in session.execute(
            select(CourseMember.course_id, func.count())
            .where(
                CourseMember.course_id.in_(ids),
                CourseMember.status == "active",
                CourseMember.left_at.is_(None),
            )
            .group_by(CourseMember.course_id)
        ).all()
    }
    groups = {
        cid: int(cnt or 0)
        for cid, cnt in session.execute(
            select(ProjectGroup.course_id, func.count())
            .where(ProjectGroup.course_id.in_(ids))
            .group_by(ProjectGroup.course_id)
        ).all()
    }
    projects = {
        cid: int(cnt or 0)
        for cid, cnt in session.execute(
            select(Project.course_id, func.count())
            .where(Project.course_id.in_(ids))
            .group_by(Project.course_id)
        ).all()
    }
    active_invites = set(
        session.scalars(
            select(CourseInvite.course_id).where(
                CourseInvite.course_id.in_(ids), CourseInvite.revoked_at.is_(None)
            )
        ).all()
    )

    items = {}
    for course, owner_name, owner_email in courses:
        items[str(course.id)] = {
            "owner_name": owner_name or str(course.owner_id),
            "owner_email": owner_email,
            "member_count": members.get(course.id, 0),
            "group_count": groups.get(course.id, 0),
            "project_count": projects.get(course.id, 0),
            "has_active_invite": course.id in active_invites,
        }
    return {"items": items}
