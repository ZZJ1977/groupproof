from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.errors import ApiError
from app.api.responses import success
from app.db.models import Milestone, ProjectMember, Task, User
from app.db.session import get_session
from app.modules.a.ai import AIUsageContext, RiskExplanationInput, explain_risk
from app.modules.a.ai.schemas import RiskRecord, TaskProgressBrief
from app.modules.c.permissions import get_project_access
from app.modules.d.acceptance import complete_by_criteria, decide, history
from app.modules.d.contribution import calculate, freeze_snapshot, latest_snapshot
from app.modules.d.integrity import enter_verification, latest_check, run_check
from app.modules.d.models import Risk, RiskEvent
from app.modules.d.risk_read import risk_counts
from app.modules.d.verification import latest_verification, run_verification

router = APIRouter(prefix="/api/d", tags=["d"])
risk_router = APIRouter(prefix="/api/v1/projects", tags=["d-risks"])
acceptance_router = APIRouter(prefix="/api/v1/projects", tags=["d-acceptance"])


class AcceptanceDecisionRequest(BaseModel):
    decision: str = Field(pattern="^(confirmed|rejected)$")
    reason: str = Field(min_length=1, max_length=2000)
    responsibility_share: float | None = Field(default=None, ge=0, le=100)

    @field_validator("reason")
    @classmethod
    def nonblank_reason(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Reason must not be blank")
        return value.strip()


class CompleteByCriteriaRequest(BaseModel):
    reason: str = Field(default="", max_length=2000)
    responsibility_share: float | None = Field(default=None, ge=0, le=100)


@acceptance_router.get("/{project_id}/tasks/{task_id}/integrity-check")
def read_integrity_check(
    project_id: UUID,
    task_id: UUID,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    return {"data": latest_check(session, project_id, task_id, user)}


@acceptance_router.post("/{project_id}/tasks/{task_id}/integrity-check")
def create_integrity_check(
    project_id: UUID,
    task_id: UUID,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    return {"data": run_check(session, project_id, task_id, user)}


@acceptance_router.post("/{project_id}/tasks/{task_id}/enter-verification")
def submit_for_verification(
    project_id: UUID,
    task_id: UUID,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    return {"data": enter_verification(session, project_id, task_id, user)}


@acceptance_router.get("/{project_id}/tasks/{task_id}/verification")
def read_verification(
    project_id: UUID,
    task_id: UUID,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    return {"data": latest_verification(session, project_id, task_id, user)}


@acceptance_router.post("/{project_id}/tasks/{task_id}/verification")
def create_verification(
    project_id: UUID,
    task_id: UUID,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    return {"data": run_verification(session, project_id, task_id, user)}


@acceptance_router.get("/{project_id}/tasks/{task_id}/verification/history")
def read_verification_history(
    project_id: UUID,
    task_id: UUID,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    return {"data": history(session, project_id, task_id, user)}


@acceptance_router.post("/{project_id}/tasks/{task_id}/verification/decision")
def create_acceptance_decision(
    project_id: UUID,
    task_id: UUID,
    payload: AcceptanceDecisionRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    from decimal import Decimal

    return {
        "data": decide(
            session,
            project_id,
            task_id,
            user,
            payload.decision,
            payload.reason,
            Decimal(str(payload.responsibility_share))
            if payload.responsibility_share is not None
            else None,
        )
    }


@acceptance_router.post("/{project_id}/tasks/{task_id}/complete-by-criteria")
def complete_task_by_criteria(
    project_id: UUID,
    task_id: UUID,
    payload: CompleteByCriteriaRequest | None = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    from decimal import Decimal

    body = payload or CompleteByCriteriaRequest()
    return {
        "data": complete_by_criteria(
            session,
            project_id,
            task_id,
            user,
            reason=body.reason,
            responsibility_share=Decimal(str(body.responsibility_share))
            if body.responsibility_share is not None
            else None,
        )
    }


@acceptance_router.get("/{project_id}/contribution")
def read_contribution(
    project_id: UUID,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    return {"data": latest_snapshot(session, project_id, user)}


@acceptance_router.post("/{project_id}/contribution/calculate")
def calculate_contribution(
    project_id: UUID,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    return {"data": calculate(session, project_id, user)}


@acceptance_router.post("/{project_id}/contribution/freeze")
def freeze_contribution(
    project_id: UUID,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    return {"data": freeze_snapshot(session, project_id, user)}


@router.get("/ready", include_in_schema=False)
def ready() -> dict[str, str]:
    return {"module": "d", "status": "ready"}


class CreateRisk(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(min_length=1)
    level: str = Field(pattern="^(low|medium|high)$")
    owner_id: UUID
    task_id: UUID | None = None
    milestone_id: UUID | None = None

    @field_validator("title", "description")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Text must not be blank")
        return value.strip()

    @model_validator(mode="after")
    def target_required(self):
        if not self.task_id and not self.milestone_id:
            raise ValueError("A task or milestone is required")
        return self


class RiskTransition(BaseModel):
    action: str = Field(pattern="^(mitigate|close)$")
    note: str = Field(min_length=1)
    expected_version: int = Field(ge=0)

    @field_validator("note")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A transition note is required")
        return value.strip()


def risk_data(session: Session, risk: Risk) -> dict:
    events = session.scalars(
        select(RiskEvent)
        .where(RiskEvent.risk_id == risk.id)
        .order_by(RiskEvent.created_at, RiskEvent.id)
    ).all()
    return {
        "id": str(risk.id),
        "project_id": str(risk.project_id),
        "task_id": str(risk.task_id) if risk.task_id else None,
        "milestone_id": str(risk.milestone_id) if risk.milestone_id else None,
        "owner_id": str(risk.owner_id),
        "title": risk.title,
        "description": risk.description,
        "level": risk.level,
        "status": risk.status,
        "version": risk.lock_version,
        "events": [
            {
                "id": str(event.id),
                "actor_id": str(event.actor_id),
                "type": event.event_type,
                "note": event.note,
                "created_at": event.created_at.isoformat(),
            }
            for event in events
        ],
    }


def require_risk_writer(access):
    if not (access.member or access.teacher):
        raise ApiError(
            403, "RISK_WRITE_DENIED", "Only project members or its teacher may manage risks."
        )
    if access.project.lifecycle != "active" or (access.course and access.course.status != "active"):
        raise ApiError(403, "PROJECT_READ_ONLY", "This project is read-only.")


@risk_router.get("/{project_id}/risks")
def list_risks(
    project_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    get_project_access(session, user, project_id)
    risks = session.scalars(
        select(Risk).where(Risk.project_id == project_id).order_by(Risk.created_at.desc(), Risk.id)
    ).all()
    return success([risk_data(session, risk) for risk in risks], request)


@risk_router.get("/{project_id}/risk-summary")
def risk_summary(
    project_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    get_project_access(session, user, project_id)
    risks = session.scalars(select(Risk).where(Risk.project_id == project_id)).all()
    active = [risk for risk in risks if risk.status != "closed"]
    return success(
        {
            **risk_counts(active),
            "risks": [
                {
                    "id": str(risk.id),
                    "title": risk.title,
                    "level": risk.level,
                    "status": risk.status,
                    "task_id": str(risk.task_id) if risk.task_id else None,
                    "milestone_id": str(risk.milestone_id) if risk.milestone_id else None,
                }
                for risk in active
            ],
        },
        request,
    )


@risk_router.get("/{project_id}/risk-explanation")
def risk_explanation(
    project_id: UUID,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    get_project_access(session, user, project_id)
    risks = session.scalars(
        select(Risk)
        .where(Risk.project_id == project_id, Risk.status != "closed")
        .order_by(Risk.created_at.desc())
        .limit(100)
    ).all()
    tasks = session.scalars(select(Task).where(Task.project_id == project_id).limit(500)).all()
    facts = [
        {
            "id": str(risk.id),
            "title": risk.title,
            "level": risk.level,
            "description": risk.description,
        }
        for risk in risks
    ]
    payload = RiskExplanationInput(
        project_id=project_id,
        tasks=[
            TaskProgressBrief(
                id=task.id,
                title=task.title,
                status=task.status,
                progress_percent=task.progress_percent,
            )
            for task in tasks
        ],
        risks=[
            RiskRecord(kind=risk.title, description=risk.description, severity=risk.level)
            for risk in risks
        ],
    )
    try:
        result = explain_risk(payload, usage=AIUsageContext(user_id=user.id, project_id=project_id))
        return success(
            {"ai_available": True, "explanation": result.model_dump(mode="json"), "facts": facts},
            request,
        )
    except ApiError as error:
        if error.status_code != 503:
            raise
        return success({"ai_available": False, "explanation": None, "facts": facts}, request)


@risk_router.post("/{project_id}/risks", status_code=201)
def create_risk(
    project_id: UUID,
    payload: CreateRisk,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    try:
        access = get_project_access(session, user, project_id, lock=True)
        require_risk_writer(access)
        owner = session.scalar(
            select(ProjectMember).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == payload.owner_id,
                ProjectMember.left_at.is_(None),
            )
        )
        if owner is None:
            raise ApiError(
                422, "RISK_OWNER_INVALID", "Risk owner must be an active project member."
            )
        if (
            payload.task_id
            and session.scalar(
                select(Task.id).where(Task.id == payload.task_id, Task.project_id == project_id)
            )
            is None
        ):
            raise ApiError(422, "RISK_TASK_INVALID", "Task does not belong to this project.")
        if (
            payload.milestone_id
            and session.scalar(
                select(Milestone.id).where(
                    Milestone.id == payload.milestone_id, Milestone.project_id == project_id
                )
            )
            is None
        ):
            raise ApiError(
                422, "RISK_MILESTONE_INVALID", "Milestone does not belong to this project."
            )
        risk = Risk(
            project_id=project_id,
            task_id=payload.task_id,
            milestone_id=payload.milestone_id,
            owner_id=payload.owner_id,
            title=payload.title.strip(),
            description=payload.description.strip(),
            level=payload.level,
            status="open",
        )
        session.add(risk)
        session.flush()
        session.add(
            RiskEvent(
                risk_id=risk.id,
                actor_id=user.id,
                event_type="created",
                note=payload.description.strip(),
            )
        )
        session.flush()
        result = risk_data(session, risk)
        session.commit()
        return success(result, request)
    except Exception:
        session.rollback()
        raise


@risk_router.post("/{project_id}/risks/{risk_id}/transitions")
def transition_risk(
    project_id: UUID,
    risk_id: UUID,
    payload: RiskTransition,
    request: Request,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    try:
        access = get_project_access(session, user, project_id, lock=True)
        require_risk_writer(access)
        risk = session.scalar(
            select(Risk).where(Risk.id == risk_id, Risk.project_id == project_id).with_for_update()
        )
        if risk is None:
            raise ApiError(404, "RISK_NOT_FOUND", "Risk not found in this project.")
        if risk.lock_version != payload.expected_version:
            raise ApiError(409, "RISK_VERSION_CONFLICT", "Risk changed; refresh before retrying.")
        if risk.status == "closed" or (payload.action == "mitigate" and risk.status != "open"):
            raise ApiError(409, "RISK_STATE_INVALID", "This risk transition is not allowed.")
        risk.status = "mitigating" if payload.action == "mitigate" else "closed"
        risk.lock_version += 1
        session.add(
            RiskEvent(
                risk_id=risk.id,
                actor_id=user.id,
                event_type=payload.action,
                note=payload.note.strip(),
            )
        )
        session.flush()
        result = risk_data(session, risk)
        session.commit()
        return success(result, request)
    except Exception:
        session.rollback()
        raise
