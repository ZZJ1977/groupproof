from uuid import UUID

from fastapi import APIRouter, Depends, Request

from app.api.responses import SuccessResponse, success
from app.modules.c.evidence_router import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    commit_command,
    private_response,
)
from app.modules.c.note_schemas import SaveTaskNote, TaskNoteDTO
from app.modules.c.note_service import get_note, save_note

router = APIRouter(
    tags=["c-task-notes"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)


@router.get(
    "/projects/{project_id}/tasks/{task_id}/note",
    response_model=SuccessResponse[TaskNoteDTO | None],
)
def read_note(
    project_id: UUID,
    task_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    history: bool = False,
):
    return success(get_note(session, user, project_id, task_id, history=history), request)


@router.put(
    "/projects/{project_id}/tasks/{task_id}/note", response_model=SuccessResponse[TaskNoteDTO]
)
def write_note(
    project_id: UUID,
    task_id: UUID,
    command: SaveTaskNote,
    request: Request,
    session: Database,
    user: CurrentUser,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session, lambda: save_note(session, user, project_id, task_id, command, idempotency_key)
        ),
        request,
    )
