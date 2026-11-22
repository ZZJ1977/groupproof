"""HTTP endpoints for course rules versioning and milestone template management."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Request

from app.modules.b import teacher_rules_service as service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.teacher_rules_schemas import PublishRules, SaveRulesDraft

router = APIRouter(
    tags=["b-teacher-rules"],
    dependencies=[Depends(private_response)],
    responses=ERROR_RESPONSES,
)


@router.get("/teacher/classes/{course_id}/rules")
def get_rules(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.get_rules_overview(session, user, course_id), request)


@router.get("/teacher/classes/{course_id}/rules/milestone-template")
def get_milestone_template(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.get_milestone_template(session, user, course_id), request)


@router.get("/teacher/classes/{course_id}/rules/{version_no}")
def get_rule_version(
    course_id: UUID, version_no: int, request: Request, session: Database, user: CurrentUser
):
    return envelope(service.get_rule_version(session, user, course_id, version_no), request)


@router.put("/teacher/classes/{course_id}/rules/draft")
def save_rules_draft(
    course_id: UUID,
    command: SaveRulesDraft,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.rules.draft:{course_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.save_rules_draft(session, user, course_id, command, request),
    )


@router.post("/teacher/classes/{course_id}/rules/publish")
def publish_rules(
    course_id: UUID,
    command: PublishRules,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=f"teacher.rules.publish:{course_id}",
        idempotency_key=key,
        payload=command.model_dump(mode="json"),
        execute=lambda: service.publish_rules(session, user, course_id, command, request),
    )
