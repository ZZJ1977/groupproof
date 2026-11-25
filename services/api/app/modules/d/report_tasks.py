"""Dedicated D report export worker, sharing the API's database models."""

import os
from datetime import UTC, datetime
from uuid import UUID

from celery import Celery
from sqlalchemy import select

from app.db.models import Project
from app.db.session import SessionLocal
from app.modules.d.contribution_week7 import archive_contribution
from app.modules.d.models import Report, ReportArtifact, ReportSnapshot
from app.modules.d.reporting import build_report_snapshot_data, render_document
from app.modules.d.risk_read import risk_advice

celery_app = Celery(
    "groupproof-d-reports",
    broker=os.getenv("REDIS_URL") or "redis://localhost:6379/0",
    backend=os.getenv("REDIS_URL") or "redis://localhost:6379/0",
)
celery_app.conf.update(
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    broker_connection_retry=False,
    broker_transport_options={
        "max_retries": 0,
        "socket_connect_timeout": 1,
        "socket_timeout": 1,
    },
    result_backend_transport_options={"retry_policy": {"max_retries": 0}},
    redis_socket_connect_timeout=1,
    redis_socket_timeout=1,
)


@celery_app.task(name="app.modules.d.report_tasks.generate_preview")
def generate_preview(snapshot_id: str, appendix: bool) -> None:
    try:
        with SessionLocal() as session:
            snapshot = session.scalar(
                select(ReportSnapshot)
                .where(ReportSnapshot.id == UUID(snapshot_id))
                .with_for_update()
            )
            if snapshot is None or snapshot.status == "generated":
                return
            report = session.get(Report, snapshot.report_id)
            project = session.scalar(
                select(Project).where(Project.id == report.project_id).with_for_update()
            )
            creator_id = snapshot.created_by or report.created_by
            data = build_report_snapshot_data(
                session,
                project.id,
                project.name,
                appendix,
                actor_id=creator_id,
                use_ai=True,
                version_no=snapshot.version_no,
            )
            snapshot.data_snapshot = data
            contribution_id = data["contribution_snapshot_id"]
            snapshot.contribution_snapshot_id = UUID(contribution_id) if contribution_id else None
            if snapshot.contribution_snapshot_id is not None:
                archive_contribution(
                    session,
                    project.id,
                    "report",
                    snapshot.id,
                    snapshot.contribution_snapshot_id,
                )
            snapshot.status = "generated"
            report.status = "generated"
            session.commit()
    except Exception:
        with SessionLocal() as session:
            snapshot = session.get(ReportSnapshot, UUID(snapshot_id))
            if snapshot is not None:
                snapshot.status = "failed"
                report = session.get(Report, snapshot.report_id)
                report.status = "failed"
                session.commit()
        raise


@celery_app.task(name="app.modules.d.report_tasks.generate_export")
def generate_export(artifact_id: str) -> None:
    with SessionLocal() as session:
        artifact = session.scalar(
            select(ReportArtifact).where(ReportArtifact.id == UUID(artifact_id)).with_for_update()
        )
        if artifact is None or artifact.status == "ready":
            return
        artifact.status = "generating"
        session.commit()
    try:
        with SessionLocal() as session:
            artifact = session.get(ReportArtifact, UUID(artifact_id))
            snapshot = session.get(ReportSnapshot, artifact.snapshot_id)
            content, _ = render_document(snapshot.data_snapshot, artifact.file_format)
            artifact.content = content
            artifact.status = "ready"
            artifact.error = None
            artifact.completed_at = datetime.now(UTC)
            session.commit()
    except Exception:
        with SessionLocal() as session:
            artifact = session.get(ReportArtifact, UUID(artifact_id))
            artifact.status = "failed"
            artifact.error = "Report generation failed; retry from the export page."
            artifact.completed_at = datetime.now(UTC)
            session.commit()
        raise


__all__ = ["celery_app", "generate_export", "generate_preview", "risk_advice"]
