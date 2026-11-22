"""D1-03/04: conservative, traceable per-criterion acceptance suggestions."""

from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.a.ai import EvidenceMatchInput, match_evidence
from app.modules.a.ai.schemas import CriterionBrief, EvidenceBrief
from app.modules.c.files_models import LogicalFile
from app.modules.c.models import Evidence, EvidenceSourceSnapshot
from app.modules.c.permissions import get_project_access, require_execution_write, require_task_plan
from app.modules.d.integrity import AcceptanceTransitionProvider, require_task, run_check
from app.modules.d.models import CriterionResult, IntegrityCheck, VerificationRun


def deterministic_result(session: Session, evidence: Evidence) -> tuple[str, str]:
    snapshot = session.scalar(
        select(EvidenceSourceSnapshot)
        .where(EvidenceSourceSnapshot.evidence_id == evidence.id)
        .order_by(EvidenceSourceSnapshot.version_no.desc())
        .limit(1)
    )
    if not snapshot or snapshot.content_json.get("availability") != "available":
        return "failed", "来源不可用。"
    source = snapshot.content_json.get("source") or {}
    if evidence.source_type in {"file", "screenshot"}:
        try:
            file_id = UUID(source["file_id"])
        except (KeyError, TypeError, ValueError):
            return "uncertain", "文件正式版本无法核对。"
        file = session.get(LogicalFile, file_id)
        if (
            file
            and file.project_id == evidence.project_id
            and file.official_version_no == source.get("version_no")
        ):
            return "passed", "文件版本已设为正式版。"
        return "failed", "文件版本尚未设为正式版。"
    if evidence.source_type == "github":
        if source.get("kind") == "pull_request":
            return (
                ("passed", "PR 已合并。")
                if source.get("state") == "merged"
                else ("failed", "PR 尚未合并。")
            )
        if source.get("kind") == "ci_run":
            return (
                ("passed", "CI 已通过。")
                if source.get("state") == "success"
                else ("failed", "CI 尚未通过。")
            )
    return "uncertain", "此证据类型没有确定性验收规则，需人工核对。"


def verification_data(session: Session, run: VerificationRun) -> dict:
    check = session.get(IntegrityCheck, run.integrity_check_id)
    details = {row["criterion_id"]: row for row in (check.details_json or [])} if check else {}
    rows = session.scalars(
        select(CriterionResult)
        .where(CriterionResult.verification_run_id == run.id)
        .order_by(CriterionResult.created_at, CriterionResult.id)
    ).all()
    return {
        "id": str(run.id),
        "project_id": str(run.project_id),
        "task_id": str(run.task_id),
        "integrity_check_id": str(run.integrity_check_id),
        "result": run.result,
        "status": run.status,
        "engine_version": run.engine_version,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "criteria": [
            {
                "criterion_id": str(row.criterion_id),
                "text": details.get(str(row.criterion_id), {}).get("text", ""),
                "evidence": details.get(str(row.criterion_id), {}).get("evidence", []),
                "result": row.result,
                "reason": row.reason,
                "remediation": row.remediation,
            }
            for row in rows
        ],
    }


def latest_verification(
    session: Session, project_id: UUID, task_id: UUID, user: User
) -> dict | None:
    get_project_access(session, user, project_id)
    require_task(session, project_id, task_id)
    run = session.scalar(
        select(VerificationRun)
        .where(VerificationRun.project_id == project_id, VerificationRun.task_id == task_id)
        .order_by(VerificationRun.created_at.desc(), VerificationRun.id.desc())
    )
    return verification_data(session, run) if run else None


def run_verification(session: Session, project_id: UUID, task_id: UUID, user: User) -> dict:
    access = get_project_access(session, user, project_id, lock=True)
    task = require_task(session, project_id, task_id)
    require_execution_write(access.project, access.course)
    require_task_plan(access.latest_plan, task_id)
    if not access.member:
        raise ApiError(403, "VERIFICATION_DENIED", "No permission to verify this task.")
    if task.status != "pending_verification":
        raise ApiError(409, "INVALID_TASK_STATE", "Task must be pending verification.")
    # Evidence may have been withdrawn since the page's last check.
    check = run_check(session, project_id, task_id, user)
    if check["status"] != "passed":
        raise ApiError(409, "INCOMPLETE_EVIDENCE", "Run the completeness check first.")
    get_project_access(session, user, project_id, lock=True)
    AcceptanceTransitionProvider(session, UUID(check["id"])).authorize(
        SimpleNamespace(task=task, project=access.project), user, "pending_verification", "recheck"
    )
    from app.modules.d.acceptance import invalidate_for_task

    invalidate_for_task(session, task_id, user.id, "已运行新的验收，旧验收结果失效")
    checked = session.get(IntegrityCheck, UUID(check["id"]))
    now = datetime.now(UTC)
    run = VerificationRun(
        integrity_check_id=checked.id,
        project_id=project_id,
        task_id=task_id,
        triggered_by=user.id,
        task_version=task.lock_version,
        result="uncertain",
        status="completed",
        engine_version="deterministic-v1+ai-advice",
        started_at=now,
        completed_at=now,
    )
    session.add(run)
    session.flush()
    outcomes: list[str] = []
    for detail in checked.details_json or []:
        evidence_ids = [UUID(row["id"]) for row in detail["evidence"]]
        evidence = session.scalars(select(Evidence).where(Evidence.id.in_(evidence_ids))).all()
        rules = [deterministic_result(session, item) for item in evidence]
        result = (
            "passed"
            if any(state == "passed" for state, _ in rules)
            else (
                "failed" if rules and all(state == "failed" for state, _ in rules) else "uncertain"
            )
        )
        outcomes.append(result)
        deterministic = "；".join(reason for _, reason in rules)
        suggestion = "AI 暂不可用；请人工复核。"
        try:
            advice = match_evidence(
                EvidenceMatchInput(
                    project_id=project_id,
                    criterion=CriterionBrief(id=UUID(detail["criterion_id"]), text=detail["text"]),
                    evidence=[
                        EvidenceBrief(
                            id=item.id,
                            kind=item.source_type,
                            text=f"{item.title}: {item.description}"[:8000],
                        )
                        for item in evidence
                    ],
                )
            )
            suggestion = (
                "AI 仅返回演示占位结果；请人工复核。"
                if advice.is_placeholder
                else f"AI 建议：{advice.verdict}；{'；'.join(advice.reasons)}"
            )
        except ApiError as exc:
            if exc.code != "AI_UNAVAILABLE":
                raise
        session.add(
            CriterionResult(
                verification_run_id=run.id,
                criterion_id=UUID(detail["criterion_id"]),
                result=result,
                reason=f"{deterministic} {suggestion}",
                remediation="请负责人逐项人工确认；本结果不是正式验收。",
            )
        )
    run.result = (
        "passed"
        if outcomes and all(item == "passed" for item in outcomes)
        else ("failed" if "failed" in outcomes else "uncertain")
    )
    session.commit()
    session.refresh(run)
    return verification_data(session, run)
