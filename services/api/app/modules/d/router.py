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
from app.modules.c.permissions import get_project_access
from app.modules.d.models import Risk, RiskEvent

router = APIRouter(prefix="/api/d", tags=["d"])
risk_router = APIRouter(prefix="/api/v1/projects", tags=["d-risks"])


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
