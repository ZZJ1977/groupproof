"""本地旧认证数据导入（PLAN 二、2：统一身份与数据）。

规则：
- 以团队 users 表（UUID）为统一身份；本地旧 ID（独立 server/ 的字符串 users.id）
  通过 auth_legacy_id_map 持久化映射，不直接转换或覆盖团队用户；
- 保留密码散列、实际角色、审核历史和账号状态；登录邮箱与学校邮箱分别保存；
- 导入幂等：映射已存在的旧用户跳过（可重复执行）；
- 发生账号冲突（用户名/邮箱等唯一性）时暂停该账号导入并记录，不自动合并；
- 只允许导入测试环境（APP_MODE != real）；生产仅升级自身数据；
- 导入前必须备份并先用 dry-run 预演。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.auth.models import (
    AcademicIdentityCheck,
    AuthAuditEvent,
    AuthIdentity,
    AuthLegacyIdMap,
    PasswordCredential,
    SchoolEmailBinding,
    TeacherApplication,
)
from app.db.models import User

# 团队全局角色优先级（旧 roles 数组 → 单一 global_role）
_ROLE_PRIORITY = ("admin", "ta", "teacher", "student")


@dataclass
class LegacyUserRow:
    """独立 server/ 的一条用户及其附属数据（由脚本从旧库读取后传入）。"""

    user: dict[str, Any]
    credential: dict[str, Any] | None = None
    email_binding: dict[str, Any] | None = None
    identities: list[dict[str, Any]] = field(default_factory=list)
    academic_checks: list[dict[str, Any]] = field(default_factory=list)
    teacher_applications: list[dict[str, Any]] = field(default_factory=list)
    audit_events: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class ImportReport:
    created: list[str] = field(default_factory=list)
    skipped_existing: list[str] = field(default_factory=list)
    conflicts: list[dict[str, str]] = field(default_factory=list)

    def summary(self) -> dict[str, int]:
        return {
            "created": len(self.created),
            "skippedExisting": len(self.skipped_existing),
            "conflicts": len(self.conflicts),
        }


def _global_role_from_roles(roles: list[str] | None) -> str:
    wanted = set(roles or [])
    for candidate in _ROLE_PRIORITY:
        if candidate in wanted:
            return candidate
    return "student"


def _status_from_account(account_status: str | None) -> str:
    return "disabled" if account_status == "disabled" else "active"


def _find_conflict(db: DbSession, row: LegacyUserRow) -> str | None:
    user = row.user
    checks: list[tuple[str, Any, Any]] = [
        ("username_normalized", User.username_normalized, user.get("username_normalized")),
        ("email", User.email, user.get("email")),
    ]
    if row.credential:
        checks.append(
            (
                "login_email_normalized",
                PasswordCredential.login_email_normalized,
                row.credential.get("login_email_normalized"),
            )
        )
    if row.email_binding and row.email_binding.get("school_email_normalized"):
        checks.append(
            (
                "school_email_normalized",
                SchoolEmailBinding.school_email_normalized,
                row.email_binding.get("school_email_normalized"),
            )
        )
    for name, column, value in checks:
        if value and db.execute(select(column).where(column == value)).first() is not None:
            return name
    return None


def import_legacy_users(
    db: DbSession,
    *,
    source: str,
    rows: list[LegacyUserRow],
    dry_run: bool = True,
) -> ImportReport:
    """导入旧用户及认证附属数据；默认 dry-run 预演。

    账号冲突时该账号整体暂停（跳过并记录），不自动合并；其余账号继续导入。
    """
    report = ImportReport()
    for row in rows:
        legacy_id = str(row.user.get("id"))
        mapped = db.execute(
            select(AuthLegacyIdMap).where(
                AuthLegacyIdMap.source == source, AuthLegacyIdMap.legacy_id == legacy_id
            )
        ).scalar_one_or_none()
        if mapped is not None:
            report.skipped_existing.append(legacy_id)
            continue

        conflict = _find_conflict(db, row)
        if conflict is not None:
            report.conflicts.append({"legacyId": legacy_id, "field": conflict})
            continue

        user = User(
            id=uuid4(),
            name=row.user.get("name"),
            username=row.user.get("username"),
            username_normalized=row.user.get("username_normalized"),
            email=row.user.get("email") or (row.credential or {}).get("login_email"),
            student_id=row.user.get("student_id"),
            college=row.user.get("college"),
            requested_identity=row.user.get("requested_identity"),
            global_role=_global_role_from_roles(row.user.get("roles")),
            status=_status_from_account(row.user.get("account_status")),
            disabled_reason=row.user.get("disabled_reason"),
            disabled_at=row.user.get("disabled_at"),
            preferred_locale=row.user.get("preferred_locale"),
            auth_version=int(row.user.get("auth_version") or 1),
            last_login_at=row.user.get("last_login_at"),
        )
        if not user.email:
            # 无任何邮箱的旧账号：保留可追溯占位（导入后应引导绑定邮箱）
            user.email = f"legacy-{legacy_id}@imported.invalid"
        if dry_run:
            report.created.append(legacy_id)
            continue

        db.add(user)
        # 先落用户行：附属表多为无 relationship 的纯外键，不参与插入排序
        db.flush()
        if row.credential:
            db.add(
                PasswordCredential(
                    user_id=user.id,
                    login_email=row.credential.get("login_email"),
                    login_email_normalized=row.credential.get("login_email_normalized"),
                    login_email_verified_at=row.credential.get("login_email_verified_at"),
                    verification_evidence_ref=row.credential.get("verification_evidence_ref"),
                    credential_version=int(row.credential.get("credential_version") or 1),
                    password_hash=row.credential.get("password_hash"),
                    password_algo=row.credential.get("password_algo") or "argon2id",
                )
            )
        if row.email_binding:
            binding = dict(row.email_binding)
            db.add(
                SchoolEmailBinding(
                    user_id=user.id,
                    school_email=binding.get("school_email"),
                    school_email_normalized=binding.get("school_email_normalized"),
                    verified_at=binding.get("verified_at"),
                    verification_method=binding.get("verification_method"),
                    pending_school_email=binding.get("pending_school_email"),
                    pending_school_email_normalized=binding.get("pending_school_email_normalized"),
                    pending_requested_at=binding.get("pending_requested_at"),
                    change_authorized_until=binding.get("change_authorized_until"),
                    change_authorized_target=binding.get("change_authorized_target"),
                )
            )
        for identity in row.identities:
            db.add(
                AuthIdentity(
                    id=identity.get("id") or uuid4().hex,
                    provider=identity.get("provider"),
                    issuer=identity.get("issuer"),
                    subject=identity.get("subject"),
                    user_id=user.id,
                    google_email=identity.get("google_email"),
                    last_authenticated_at=identity.get("last_authenticated_at"),
                )
            )
        for check in row.academic_checks:
            check_kwargs: dict[str, Any] = {
                "id": check.get("id") or uuid4().hex,
                "user_id": user.id,
                "checked_fields": check.get("checked_fields") or [],
                "snapshot": check.get("snapshot") or {},
                "method": check.get("method"),
                "result": check.get("result"),
                "evidence_ref": check.get("evidence_ref"),
                "superseded_at": check.get("superseded_at"),
            }
            if check.get("checked_at") is not None:
                check_kwargs["checked_at"] = check.get("checked_at")
            db.add(AcademicIdentityCheck(**check_kwargs))
        for application in row.teacher_applications:
            db.add(
                TeacherApplication(
                    id=application.get("id") or uuid4().hex,
                    user_id=user.id,
                    application_version=int(application.get("application_version") or 1),
                    snapshot=application.get("snapshot") or {},
                    status=application.get("status"),
                    reviewed_at=application.get("reviewed_at"),
                    reason=application.get("reason"),
                )
            )
        for event in row.audit_events:
            db.add(
                AuthAuditEvent(
                    id=event.get("id") or uuid4().hex,
                    event_type=event.get("event_type"),
                    actor_id=str(event.get("actor_id")) if event.get("actor_id") else None,
                    target_user_id=str(user.id),
                    result=event.get("result") or "success",
                    changed_fields=event.get("changed_fields") or [],
                )
            )
        db.add(AuthLegacyIdMap(source=source, legacy_id=legacy_id, user_id=user.id))
        report.created.append(legacy_id)
    return report
