from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.api.responses import SuccessResponse, success
from app.modules.c.discussion_schemas import (
    CreateDiscussion,
    DiscussionDTO,
    DiscussionPageDTO,
    DiscussionRepliesPageDTO,
    DiscussionReplyResultDTO,
    MarkDiscussionImportant,
    ReplyDiscussion,
)
from app.modules.c.discussion_service import (
    add_reply,
    create_discussion,
    get_discussion,
    list_discussions,
    list_replies,
    mark_important,
)
from app.modules.c.evidence_router import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    commit_command,
    private_response,
)

router = APIRouter(
    tags=["c-discussions"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)


@router.get("/projects/{project_id}/discussions", response_model=SuccessResponse[DiscussionPageDTO])
def collection(
    project_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    task_id: UUID | None = None,
    requirement_id: UUID | None = None,
    module_id: UUID | None = None,
    milestone_id: UUID | None = None,
    is_important: bool | None = None,
    q: str | None = Query(default=None, max_length=200),
):
    return success(
        list_discussions(
            session,
            user,
            project_id,
            page=page,
            page_size=page_size,
            task_id=task_id,
            requirement_id=requirement_id,
            module_id=module_id,
            milestone_id=milestone_id,
            is_important=is_important,
            q=q,
        ),
        request,
    )


@router.get(
    "/projects/{project_id}/discussions/{discussion_id}",
    response_model=SuccessResponse[DiscussionDTO],
)
def detail(
    project_id: UUID,
    discussion_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
):
    return success(get_discussion(session, user, project_id, discussion_id), request)


@router.post(
    "/projects/{project_id}/discussions",
    status_code=201,
    response_model=SuccessResponse[DiscussionDTO],
)
def create(
    project_id: UUID,
    command: CreateDiscussion,
    request: Request,
    session: Database,
    user: CurrentUser,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session, lambda: create_discussion(session, user, project_id, command, idempotency_key)
        ),
        request,
    )


@router.get(
    "/projects/{project_id}/discussions/{discussion_id}/replies",
    response_model=SuccessResponse[DiscussionRepliesPageDTO],
)
def replies(
    project_id: UUID,
    discussion_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    focus_reply_id: UUID | None = None,
):
    return success(
        list_replies(
            session,
            user,
            project_id,
            discussion_id,
            page=page,
            page_size=page_size,
            focus_reply_id=focus_reply_id,
        ),
        request,
    )


@router.post(
    "/projects/{project_id}/discussions/{discussion_id}/replies",
    status_code=201,
    response_model=SuccessResponse[DiscussionReplyResultDTO],
)
def reply(
    project_id: UUID,
    discussion_id: UUID,
    command: ReplyDiscussion,
    request: Request,
    session: Database,
    user: CurrentUser,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session,
            lambda: add_reply(session, user, project_id, discussion_id, command, idempotency_key),
        ),
        request,
    )


@router.put(
    "/projects/{project_id}/discussions/{discussion_id}/important",
    response_model=SuccessResponse[DiscussionDTO],
)
def important(
    project_id: UUID,
    discussion_id: UUID,
    command: MarkDiscussionImportant,
    request: Request,
    session: Database,
    user: CurrentUser,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session,
            lambda: mark_important(
                session, user, project_id, discussion_id, command, idempotency_key
            ),
        ),
        request,
    )
