"""GroupProof-specific Admin Workbench schemas (operations, 360 profile, FinOps, proof pipeline)."""

from __future__ import annotations

from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator


class WorkbenchDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AiErrorCountDTO(WorkbenchDTO):
    error_code: str
    count: int = Field(ge=0)
    last_seen_at: AwareDatetime | None = None


class OverviewUsersDTO(WorkbenchDTO):
    total: int = Field(ge=0)
    active: int = Field(ge=0)
    pending: int = Field(ge=0)
    disabled: int = Field(ge=0)
    verified_school_email: int = Field(ge=0)
    unverified_school_email: int = Field(ge=0)
    google_linked: int = Field(ge=0)
    github_verified: int = Field(ge=0)
    by_role: dict[str, int]
    new_last_7d: int = Field(ge=0)
    active_last_7d: int = Field(ge=0)


class OverviewQueuesDTO(WorkbenchDTO):
    pending_teacher_applications: int = Field(ge=0)
    pending_access_requests: int = Field(ge=0)
    active_access_grants: int = Field(ge=0)
    undelivered_outbox: int = Field(ge=0)


class OverviewTeachingDTO(WorkbenchDTO):
    courses_total: int = Field(ge=0)
    courses_draft: int = Field(ge=0)
    courses_active: int = Field(ge=0)
    courses_ended: int = Field(ge=0)
    groups_total: int = Field(ge=0)
    projects_total: int = Field(ge=0)
    projects_active: int = Field(ge=0)
    tasks_total: int = Field(ge=0)
    formal_evidences_total: int = Field(ge=0)


class OverviewProofPipelineDTO(WorkbenchDTO):
    github_repo_links: int = Field(ge=0)
    github_synced_24h: int = Field(ge=0)
    github_stale_links: int = Field(ge=0)
    feishu_chat_links: int = Field(ge=0)
    feishu_messages_7d: int = Field(ge=0)
    upload_completed_count: int = Field(ge=0)
    upload_total_bytes: int = Field(ge=0)
    upload_rejected_count: int = Field(ge=0)
    email_challenges_7d: int = Field(ge=0)
    email_challenges_failed_7d: int = Field(ge=0)
    notification_emails_failed_7d: int = Field(ge=0)


class OverviewAiDTO(WorkbenchDTO):
    requests: int = Field(ge=0)
    succeeded: int = Field(ge=0)
    failed: int = Field(ge=0)
    success_rate: float | None = None
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    p95_latency_ms: int | None = None
    cost_by_currency: dict[str, str]
    unpriced_requests: int = Field(ge=0)
    top_errors: list[AiErrorCountDTO]


class OverviewActivityDayDTO(WorkbenchDTO):
    date: date
    new_users: int = Field(ge=0)
    audit_events: int = Field(ge=0)
    ai_requests: int = Field(ge=0)
    ai_failed: int = Field(ge=0)
    github_activities: int = Field(ge=0)
    feishu_messages: int = Field(ge=0)


class OverviewRecentUserDTO(WorkbenchDTO):
    id: UUID
    name: str
    school_email: str | None = None
    school_email_verified: bool
    role: str
    status: str
    college: str
    created_at: AwareDatetime
    last_login_at: AwareDatetime | None = None


class SystemHealthItemDTO(WorkbenchDTO):
    key: str
    label: str
    status: Literal["healthy", "warning", "degraded"]
    detail: str


class AdminOverviewDTO(WorkbenchDTO):
    generated_at: AwareDatetime
    users: OverviewUsersDTO
    queues: OverviewQueuesDTO
    teaching: OverviewTeachingDTO
    proof_pipeline: OverviewProofPipelineDTO
    ai_7d: OverviewAiDTO
    activity_7d: list[OverviewActivityDayDTO]
    recent_users: list[OverviewRecentUserDTO]
    system_health: list[SystemHealthItemDTO]


class UserVerificationMatrixDTO(WorkbenchDTO):
    school_email: str | None = None
    school_email_verified: bool
    school_email_verified_at: AwareDatetime | None = None
    pending_school_email: str | None = None
    has_password: bool
    login_email_verified: bool
    google_linked: bool
    google_email: str | None = None
    github_verified: bool
    github_login: str | None = None


class UserSessionSummaryDTO(WorkbenchDTO):
    id: str
    scope: str
    auth_method: str | None = None
    created_at: AwareDatetime
    last_seen_at: AwareDatetime
    expires_at: AwareDatetime
    revoked_at: AwareDatetime | None = None
    revoke_reason: str | None = None


class UserSessionsOverviewDTO(WorkbenchDTO):
    active_count: int = Field(ge=0)
    recent: list[UserSessionSummaryDTO]


class UserTeachingSummaryDTO(WorkbenchDTO):
    owned_courses: int = Field(ge=0)
    enrolled_courses: int = Field(ge=0)
    staff_courses: int = Field(ge=0)
    member_projects: int = Field(ge=0)
    active_access_grants: int = Field(ge=0)


class UserAiSummaryDTO(WorkbenchDTO):
    requests: int = Field(ge=0)
    failed: int = Field(ge=0)
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    cost_by_currency: dict[str, str]


class UserAuthEventSummaryDTO(WorkbenchDTO):
    id: str
    event_type: str
    result: str
    occurred_at: AwareDatetime


class AdminUserProfile360DTO(WorkbenchDTO):
    user_id: UUID
    name: str
    username: str | None = None
    student_id: str | None = None
    college: str
    global_role: str
    status: str
    created_at: AwareDatetime
    last_login_at: AwareDatetime | None = None
    disabled_at: AwareDatetime | None = None
    disabled_reason: str | None = None
    verification: UserVerificationMatrixDTO
    sessions: UserSessionsOverviewDTO
    teaching_summary: UserTeachingSummaryDTO
    ai_30d: UserAiSummaryDTO
    recent_auth_events: list[UserAuthEventSummaryDTO]


class RevokeUserSessionsRequest(WorkbenchDTO):
    reason: str = Field(min_length=1, max_length=2000)

    @field_validator("reason")
    @classmethod
    def non_blank_reason(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Reason is required")
        return cleaned


class RevokeUserSessionsDTO(WorkbenchDTO):
    user_id: UUID
    revoked_count: int = Field(ge=0)
    auth_version: int = Field(ge=0)


class AccessGrantFilters(WorkbenchDTO):
    page: int = Field(default=1, ge=1, le=1_000_000)
    page_size: int = Field(default=10, ge=1, le=100)
    status: Literal["active", "expired", "revoked", "all"] = "active"


class AdminAccessGrantItemDTO(WorkbenchDTO):
    id: UUID
    request_id: UUID
    applicant_id: UUID
    applicant_name: str
    applicant_email: str | None = None
    reviewer_id: UUID | None = None
    reviewer_name: str | None = None
    project_id: UUID
    project_name: str
    course_code: str | None = None
    resource_type: Literal["project", "task", "evidence"]
    resource_id: UUID
    created_at: AwareDatetime
    expires_at: AwareDatetime
    revoked_at: AwareDatetime | None = None
    revoked_by_name: str | None = None
    revoke_reason: str | None = None
    state: Literal["active", "expired", "revoked"]


class AdminAccessGrantPageDTO(WorkbenchDTO):
    items: list[AdminAccessGrantItemDTO]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)


class AiDiagnosticsFilters(WorkbenchDTO):
    days: Literal[7, 30, 90] = 7
    user_id: UUID | None = None
    feature: str | None = Field(default=None, min_length=1, max_length=100)
    model: str | None = Field(default=None, min_length=1, max_length=160)

    @field_validator("days", mode="before")
    @classmethod
    def query_days(cls, value):
        return int(value) if isinstance(value, str) and value in {"7", "30", "90"} else value


class AiTopUserDTO(WorkbenchDTO):
    user_id: UUID | None = None
    user_name: str
    role: str | None = None
    requests: int = Field(ge=0)
    failed: int = Field(ge=0)
    total_tokens: int = Field(ge=0)
    cost_by_currency: dict[str, str]


class AiTopProjectDTO(WorkbenchDTO):
    project_id: UUID | None = None
    project_name: str
    course_code: str | None = None
    requests: int = Field(ge=0)
    failed: int = Field(ge=0)
    total_tokens: int = Field(ge=0)
    cost_by_currency: dict[str, str]


class AiFailureItemDTO(WorkbenchDTO):
    id: UUID
    occurred_at: AwareDatetime
    user_id: UUID | None = None
    user_name: str
    project_id: UUID | None = None
    project_name: str | None = None
    feature: str
    model: str | None = None
    error_code: str | None = None
    latency_ms: int | None = None


class AiSummaryJobsDTO(WorkbenchDTO):
    total: int = Field(ge=0)
    pending: int = Field(ge=0)
    failed: int = Field(ge=0)
    needs_human_review: int = Field(ge=0)


class AiHourlyPointDTO(WorkbenchDTO):
    hour_start: AwareDatetime
    requests: int = Field(ge=0)
    succeeded: int = Field(ge=0)
    failed: int = Field(ge=0)
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    cost_by_currency: dict[str, str]


class AdminAiDiagnosticsDTO(WorkbenchDTO):
    days: Literal[7, 30, 90]
    since: AwareDatetime
    until: AwareDatetime
    total_requests: int = Field(ge=0)
    succeeded: int = Field(ge=0)
    failed: int = Field(ge=0)
    avg_latency_ms: int | None = None
    p50_latency_ms: int | None = None
    p95_latency_ms: int | None = None
    error_breakdown: list[AiErrorCountDTO]
    top_users: list[AiTopUserDTO]
    top_projects: list[AiTopProjectDTO]
    recent_failures: list[AiFailureItemDTO]
    summary_jobs: AiSummaryJobsDTO
    hourly_24h: list[AiHourlyPointDTO]


class GithubLinkHealthDTO(WorkbenchDTO):
    id: UUID
    project_id: UUID
    project_name: str
    course_code: str | None = None
    repo_full_name: str
    default_branch: str
    last_synced_at: AwareDatetime | None = None
    activity_count: int = Field(ge=0)
    health: Literal["healthy", "stale", "never_synced"]


class GithubIntegrationStatusDTO(WorkbenchDTO):
    total_links: int = Field(ge=0)
    synced_24h: int = Field(ge=0)
    stale_over_48h: int = Field(ge=0)
    never_synced: int = Field(ge=0)
    activities_7d: int = Field(ge=0)
    verified_identities: int = Field(ge=0)
    links: list[GithubLinkHealthDTO]


class FeishuLinkHealthDTO(WorkbenchDTO):
    id: UUID
    project_id: UUID
    project_name: str
    course_code: str | None = None
    chat_id_masked: str
    linked_at: AwareDatetime
    message_count: int = Field(ge=0)
    last_message_at: AwareDatetime | None = None


class FeishuIntegrationStatusDTO(WorkbenchDTO):
    total_links: int = Field(ge=0)
    messages_7d: int = Field(ge=0)
    deleted_messages_7d: int = Field(ge=0)
    attachments_total: int = Field(ge=0)
    links: list[FeishuLinkHealthDTO]


class EmailDeliveryFailureDTO(WorkbenchDTO):
    id: str
    kind: Literal["challenge", "notification"]
    purpose: str
    recipient_domain: str
    status: str
    occurred_at: AwareDatetime


class EmailDeliveryStatusDTO(WorkbenchDTO):
    challenges_7d: int = Field(ge=0)
    challenges_accepted_7d: int = Field(ge=0)
    challenges_captured_7d: int = Field(ge=0)
    challenges_failed_7d: int = Field(ge=0)
    notifications_email_pending: int = Field(ge=0)
    notifications_email_sent_7d: int = Field(ge=0)
    notifications_email_failed_7d: int = Field(ge=0)
    recent_failures: list[EmailDeliveryFailureDTO]


class StorageAndEvidenceStatusDTO(WorkbenchDTO):
    upload_completed: int = Field(ge=0)
    upload_pending: int = Field(ge=0)
    upload_rejected: int = Field(ge=0)
    total_bytes: int = Field(ge=0)
    evidence_total: int = Field(ge=0)
    evidence_formal: int = Field(ge=0)
    evidence_pending_confirmation: int = Field(ge=0)
    evidence_withdrawn_or_void: int = Field(ge=0)
    activity_summaries_failed: int = Field(ge=0)
    outbox_pending: int = Field(ge=0)


class RateLimitBucketDTO(WorkbenchDTO):
    bucket_prefix: str
    total_hits: int = Field(ge=0)
    latest_window: AwareDatetime


class RateLimitsStatusDTO(WorkbenchDTO):
    active_buckets_24h: int = Field(ge=0)
    top_buckets: list[RateLimitBucketDTO]


class AdminIntegrationsStatusDTO(WorkbenchDTO):
    generated_at: AwareDatetime
    github: GithubIntegrationStatusDTO
    feishu: FeishuIntegrationStatusDTO
    email_delivery: EmailDeliveryStatusDTO
    storage_and_evidence: StorageAndEvidenceStatusDTO
    rate_limits: RateLimitsStatusDTO


class ResolveLabelsRequest(WorkbenchDTO):
    user_ids: list[UUID] = Field(default_factory=list, max_length=100)
    course_ids: list[UUID] = Field(default_factory=list, max_length=100)
    project_ids: list[UUID] = Field(default_factory=list, max_length=100)


class ResolvedUserDTO(WorkbenchDTO):
    id: UUID
    name: str
    role: str
    student_id: str | None = None
    college: str | None = None


class ResolvedCourseDTO(WorkbenchDTO):
    id: UUID
    code: str
    name: str
    semester: str
    status: str


class ResolvedProjectDTO(WorkbenchDTO):
    id: UUID
    name: str
    course_id: UUID | None = None
    course_code: str | None = None
    lifecycle: str


class ResolveLabelsDTO(WorkbenchDTO):
    users: dict[str, ResolvedUserDTO]
    courses: dict[str, ResolvedCourseDTO]
    projects: dict[str, ResolvedProjectDTO]


class CourseMetricsRequest(WorkbenchDTO):
    course_ids: list[UUID] = Field(min_length=1, max_length=100)


class CourseMetricItemDTO(WorkbenchDTO):
    owner_name: str
    owner_email: str | None = None
    member_count: int = Field(ge=0)
    group_count: int = Field(ge=0)
    project_count: int = Field(ge=0)
    has_active_invite: bool


class CourseMetricsResponseDTO(WorkbenchDTO):
    items: dict[str, CourseMetricItemDTO]


class AdminProjectFilters(WorkbenchDTO):
    page: int = Field(default=1, ge=1, le=1_000_000)
    page_size: int = Field(default=10, ge=1, le=100)
    q: str | None = Field(default=None, max_length=200)
    origin: Literal["all", "standalone", "course"] = "all"
    lifecycle: Literal["all", "active", "finalized", "archived"] = "all"
    visibility: Literal["all", "members", "course"] = "all"
    has_github: Literal["all", "yes", "no"] = "all"
    has_feishu: Literal["all", "yes", "no"] = "all"


class AdminProjectsSummaryDTO(WorkbenchDTO):
    total: int = Field(ge=0)
    standalone: int = Field(ge=0)
    course_bound: int = Field(ge=0)
    active: int = Field(ge=0)
    finalized: int = Field(ge=0)
    archived: int = Field(ge=0)
    github_linked: int = Field(ge=0)
    feishu_linked: int = Field(ge=0)


class AdminProjectListItemDTO(WorkbenchDTO):
    id: UUID
    name: str
    origin: Literal["standalone", "course"]
    course_id: UUID | None = None
    course_code: str | None = None
    course_name: str | None = None
    project_type: str | None = None
    visibility: Literal["members", "course"]
    setup_status: str
    lifecycle: Literal["active", "finalized", "archived"]
    lock_version: int = Field(ge=0)
    leader_id: UUID | None = None
    leader_name: str | None = None
    member_count: int = Field(ge=0)
    task_count: int = Field(ge=0)
    evidence_formal_count: int = Field(ge=0)
    github_linked: bool
    github_repo: str | None = None
    github_last_synced_at: AwareDatetime | None = None
    feishu_linked: bool
    ai_requests_30d: int = Field(ge=0)
    ai_cost_30d_by_currency: dict[str, str]
    created_at: AwareDatetime
    updated_at: AwareDatetime
    archived_at: AwareDatetime | None = None


class AdminProjectPageDTO(WorkbenchDTO):
    summary: AdminProjectsSummaryDTO
    items: list[AdminProjectListItemDTO]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)


class AdminProjectMemberDTO(WorkbenchDTO):
    user_id: UUID
    name: str
    student_id: str | None = None
    college: str
    role: Literal["leader", "member"]
    school_email_verified: bool
    joined_at: AwareDatetime


class AdminProjectCountsDTO(WorkbenchDTO):
    tasks_total: int = Field(ge=0)
    tasks_done: int = Field(ge=0)
    requirements_total: int = Field(ge=0)
    formal_evidences_total: int = Field(ge=0)
    upload_completed_count: int = Field(ge=0)
    upload_total_bytes: int = Field(ge=0)
    active_access_grants: int = Field(ge=0)


class AdminProjectGithubSummaryDTO(WorkbenchDTO):
    linked: bool
    repo_full_name: str | None = None
    default_branch: str | None = None
    last_synced_at: AwareDatetime | None = None
    activity_count: int = Field(ge=0)


class AdminProjectFeishuSummaryDTO(WorkbenchDTO):
    linked: bool
    chat_id_masked: str | None = None
    linked_at: AwareDatetime | None = None
    message_count: int = Field(ge=0)
    last_message_at: AwareDatetime | None = None


class AdminProjectAuditItemDTO(WorkbenchDTO):
    id: UUID
    occurred_at: AwareDatetime
    action: str
    actor_name: str
    actor_role: str | None = None
    result: str
    reason: str | None = None


class AdminProjectDetailDTO(WorkbenchDTO):
    id: UUID
    name: str
    origin: Literal["standalone", "course"]
    course_id: UUID | None = None
    course_code: str | None = None
    course_name: str | None = None
    project_type: str | None = None
    language: str | None = None
    visibility: Literal["members", "course"]
    setup_status: str
    setup_step: int = Field(ge=0)
    lifecycle: Literal["active", "finalized", "archived"]
    lock_version: int = Field(ge=0)
    final_deadline: AwareDatetime | None = None
    archived_at: AwareDatetime | None = None
    created_at: AwareDatetime
    updated_at: AwareDatetime
    members: list[AdminProjectMemberDTO]
    counts: AdminProjectCountsDTO
    github: AdminProjectGithubSummaryDTO
    feishu: AdminProjectFeishuSummaryDTO
    ai_30d: UserAiSummaryDTO
    recent_audit_events: list[AdminProjectAuditItemDTO]


class UpdateProjectLifecycleRequest(WorkbenchDTO):
    action: Literal["archive", "restore", "finalize"]
    expected_version: int = Field(ge=0)
    reason: str = Field(min_length=1, max_length=2000)

    @field_validator("reason")
    @classmethod
    def non_blank_reason(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Reason is required")
        return cleaned
