from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.api.responses import SuccessResponse, success
from app.modules.c import inbox_service as service
from app.modules.c.evidence_router import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    commit_command,
    private_response,
)
from app.modules.c.inbox_ports import InboxPort, get_inbox_port
from app.modules.c.inbox_schemas import (
    ActionItemFilters,
    ActionItemPageDTO,
    MarkAllNotificationsRead,
    MarkNotificationRead,
    NotificationFilters,
    NotificationPageDTO,
    NotificationReadReceipt,
)

router = APIRouter(
    tags=["c-inbox"], dependencies=[Depends(private_response)], responses=ERROR_RESPONSES
)
Inbox = Annotated[InboxPort, Depends(get_inbox_port)]


@router.get("/me/notifications", response_model=SuccessResponse[NotificationPageDTO])
def notification_list(
    request: Request,
    session: Database,
    user: CurrentUser,
    inbox: Inbox,
    filters: Annotated[NotificationFilters, Query()],
):
    return success(service.notifications(session, user, filters, inbox), request)


@router.post("/me/notifications/read-all", response_model=SuccessResponse[NotificationReadReceipt])
def read_all(
    command: MarkAllNotificationsRead,
    request: Request,
    session: Database,
    user: CurrentUser,
    inbox: Inbox,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session, lambda: service.mark_read(session, user, command, idempotency_key, inbox)
        ),
        request,
    )


@router.post(
    "/me/notifications/{notification_id}/read",
    response_model=SuccessResponse[NotificationReadReceipt],
)
def read_one(
    notification_id: UUID,
    command: MarkNotificationRead,
    request: Request,
    session: Database,
    user: CurrentUser,
    inbox: Inbox,
    idempotency_key: IdempotencyKey,
):
    return success(
        commit_command(
            session,
            lambda: service.mark_read(
                session, user, command, idempotency_key, inbox, notification_id=notification_id
            ),
        ),
        request,
    )


@router.get("/me/action-items", response_model=SuccessResponse[ActionItemPageDTO])
def action_list(
    request: Request,
    session: Database,
    user: CurrentUser,
    inbox: Inbox,
    filters: Annotated[ActionItemFilters, Query()],
):
    return success(service.action_items(session, user, filters, inbox), request)
