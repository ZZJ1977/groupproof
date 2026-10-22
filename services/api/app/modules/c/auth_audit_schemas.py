"""C's limited read contract for A authentication events, not all-site audit."""

from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

AuthAuditAction = Literal[
    "admin.bootstrapped",
    "auth.acceptance_test_entry",
    "auth.email_registered",
    "auth.google.cancelled",
    "auth.login",
    "auth.logout",
    "auth.password_change",
    "auth.password_login",
    "auth.password_login.rate_limited",
    "auth.password_register.closed_path",
    "auth.registered",
    "auth.session_refresh",
    "email_challenge.consume_failed",
    "email_challenge.rate_limited",
    "email_challenge.send_failed",
    "email_challenge.sent",
    "login_email.verified",
    "password_recovery.notice_failed",
    "password_recovery.requested_ineligible",
    "password_recovery.reset",
    "password_recovery.sent",
    "pre_registration.code_verified",
    "pre_registration.created",
    "preferences.updated",
    "profile.updated",
    "role.granted_student",
    "school_email.change_authorized",
    "school_email.change_requested",
    "school_email.verified",
    "teacher.role_revoked_basis_changed",
    "teacher_application.approved",
    "teacher_application.rejected",
    "teacher_application.resubmitted",
    "teacher_application.submitted",
    "user.disabled",
]
AuthAuditId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]
AuthAuditActor = UUID | Literal["system"]


class AuthAuditContract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AuthAuditFilters(AuthAuditContract):
    page: int = Field(default=1, ge=1, le=1_000_000)
    page_size: int = Field(default=10, ge=1, le=100)
    action: AuthAuditAction | None = None
    result: Literal["success", "failure"] | None = None
    actor_id: AuthAuditActor | None = None
    target_user_id: UUID | None = None
    since: AwareDatetime | None = None
    until: AwareDatetime | None = None

    @model_validator(mode="after")
    def ordered_dates(self) -> Self:
        if self.since and self.until and self.since >= self.until:
            raise ValueError("since must precede until (exclusive)")
        return self


class AuthAuditLogDTO(AuthAuditContract):
    id: AuthAuditId
    source: Literal["auth_audit_events"] = "auth_audit_events"
    scope: Literal["authentication"] = "authentication"
    action: AuthAuditAction | Literal["unrecognized"]
    actor_id: AuthAuditActor | None
    target_user_id: UUID | None
    result: Literal["success", "failure", "unknown"]
    occurred_at: AwareDatetime
    changed_fields: list[str]
    metadata_redacted: bool


class AuthAuditPageDTO(AuthAuditContract):
    source: Literal["auth_audit_events"] = "auth_audit_events"
    scope: Literal["authentication"] = "authentication"
    items: list[AuthAuditLogDTO]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)
