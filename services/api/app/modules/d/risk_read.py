"""Shared current-risk counts for project and teacher views."""

from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import Task
from app.modules.a.ai import AIUsageContext, RiskExplanationInput, explain_risk
from app.modules.a.ai.schemas import RiskRecord, TaskProgressBrief
from app.modules.d.models import Risk


def risk_counts(risks: Iterable[Risk]) -> dict[str, int]:
    active = [risk for risk in risks if risk.status != "closed"]
    return {
        "total": len(active),
        "high": sum(risk.level == "high" for risk in active),
        "medium": sum(risk.level == "medium" for risk in active),
        "low": sum(risk.level == "low" for risk in active),
    }


def risk_advice(session: Session, project_id: UUID, user_id: UUID) -> dict | None:
    """Return A's advice or None while preserving deterministic risk facts."""
    tasks = session.scalars(select(Task).where(Task.project_id == project_id).limit(500)).all()
    risks = session.scalars(
        select(Risk)
        .where(Risk.project_id == project_id, Risk.status != "closed")
        .order_by(Risk.created_at.desc())
        .limit(100)
    ).all()
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
        result = explain_risk(payload, usage=AIUsageContext(user_id=user_id, project_id=project_id))
        return result.model_dump(mode="json")
    except ApiError as error:
        if error.status_code != 503:
            raise
        return None
