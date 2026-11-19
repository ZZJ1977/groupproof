"""Teacher class management, student roster, team plaza, and group detail HTTP routes."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from app.api.errors import ApiError
from app.modules.b import teacher_classes_service as service
from app.modules.b.common import (
    ERROR_RESPONSES,
    CurrentUser,
    Database,
    IdempotencyKey,
    envelope,
    private_response,
    run_command,
)
from app.modules.b.teacher_classes_schemas import (
    ArchiveClass,
    Assign,
    ClassTab,
    CreateClass,
    EndClass,
    RemoveStudent,
    ReopenClass,
    RosterFilter,
    RotateInvite,
    SetLeader,
    TeacherCreateGroup,
    UpdateSettings,
)

router = APIRouter(
    tags=["b-teacher-classes"],
    dependencies=[Depends(private_response)],
    responses=ERROR_RESPONSES,
)


def _write(
    session,
    request,
    user,
    key,
    operation: str,
    payload,
    execute,
    status_code: int = 200,
    integrity_error: ApiError | None = None,
):
    return run_command(
        session,
        request,
        actor=user,
        operation=operation,
        idempotency_key=key,
        payload=payload,
        execute=execute,
        status_code=status_code,
        integrity_error=integrity_error,
    )


@router.get("/teacher/classes")
def list_classes(
    request: Request,
    session: Database,
    user: CurrentUser,
    tab: ClassTab = Query(default="all"),
    q: str | None = Query(default=None, max_length=100),
):
    return envelope(service.list_classes(session, user, tab, q), request)


@router.post("/teacher/classes", status_code=201)
def create_class(
    command: CreateClass,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return _write(
        session,
        request,
        user,
        key,
        "teacher.class.create",
        command.model_dump(mode="json"),
        lambda: service.create_class(session, user, command, request),
        201,
        integrity_error=ApiError(
            409, "COURSE_CODE_CONFLICT", "该课程编号已存在。", details={"field": "code"}
        ),
    )


@router.get("/teacher/classes/{course_id}")
def get_class(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.get_class(session, user, course_id), request)


@router.post("/teacher/classes/{course_id}/invite-code/rotate")
def rotate_invite(
    course_id: UUID,
    command: RotateInvite,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return _write(
        session,
        request,
        user,
        key,
        f"teacher.class.rotate:{course_id}",
        command.model_dump(mode="json"),
        lambda: service.rotate_invite(session, user, course_id, command, request),
    )


@router.get("/teacher/classes/{course_id}/roster")
def roster(
    course_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    q: str | None = Query(default=None, max_length=100),
    status: RosterFilter = Query(default="all"),
):
    return envelope(service.roster(session, user, course_id, q, status), request)


@router.post("/teacher/classes/{course_id}/students/{student_id}/remove")
def remove_student(
    course_id: UUID,
    student_id: UUID,
    command: RemoveStudent,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return _write(
        session,
        request,
        user,
        key,
        f"teacher.class.remove_student:{course_id}:{student_id}",
        command.model_dump(mode="json"),
        lambda: service.remove_student(session, user, course_id, student_id, command, request),
    )


@router.get("/teacher/classes/{course_id}/plaza")
def plaza(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.plaza(session, user, course_id), request)


@router.post("/teacher/classes/{course_id}/groups", status_code=201)
def create_group(
    course_id: UUID,
    command: TeacherCreateGroup,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return _write(
        session,
        request,
        user,
        key,
        f"teacher.group.create:{course_id}",
        command.model_dump(mode="json"),
        lambda: service.create_group(session, user, course_id, command, request),
        201,
        integrity_error=ApiError(
            409, "GROUP_NAME_TAKEN", "本班级已有同名队伍。", details={"field": "name"}
        ),
    )


@router.post("/teacher/classes/{course_id}/assignments")
def assign(
    course_id: UUID,
    command: Assign,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return _write(
        session,
        request,
        user,
        key,
        f"teacher.assign:{course_id}",
        command.model_dump(mode="json"),
        lambda: service.assign(session, user, course_id, command, request),
    )


@router.post("/teacher/classes/{course_id}/groups/{group_id}/leader")
def set_leader(
    course_id: UUID,
    group_id: UUID,
    command: SetLeader,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return _write(
        session,
        request,
        user,
        key,
        f"teacher.group.leader:{course_id}:{group_id}",
        command.model_dump(mode="json"),
        lambda: service.set_leader(session, user, course_id, group_id, command, request),
    )


@router.get("/teacher/classes/{course_id}/groups/{group_id}")
def group_detail(
    course_id: UUID,
    group_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
):
    return envelope(service.group_detail(session, user, course_id, group_id), request)


@router.get("/teacher/classes/{course_id}/settings")
def get_settings(course_id: UUID, request: Request, session: Database, user: CurrentUser):
    return envelope(service.get_settings(session, user, course_id), request)


@router.patch("/teacher/classes/{course_id}/settings")
def update_settings(
    course_id: UUID,
    command: UpdateSettings,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return _write(
        session,
        request,
        user,
        key,
        f"teacher.class.settings:{course_id}",
        command.model_dump(mode="json"),
        lambda: service.update_settings(session, user, course_id, command, request),
    )


@router.post("/teacher/classes/{course_id}/end")
def end_class(
    course_id: UUID,
    command: EndClass,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return _write(
        session,
        request,
        user,
        key,
        f"teacher.class.end:{course_id}",
        command.model_dump(mode="json"),
        lambda: service.end_class(session, user, course_id, command, request),
    )


@router.post("/teacher/classes/{course_id}/archive")
def archive_class(
    course_id: UUID,
    command: ArchiveClass,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return _write(
        session,
        request,
        user,
        key,
        f"teacher.class.archive:{course_id}",
        command.model_dump(mode="json"),
        lambda: service.archive_class(session, user, course_id, command, request),
    )


@router.post("/teacher/classes/{course_id}/reopen")
def reopen_class(
    course_id: UUID,
    command: ReopenClass,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return _write(
        session,
        request,
        user,
        key,
        f"teacher.class.reopen:{course_id}",
        command.model_dump(mode="json"),
        lambda: service.reopen_class(session, user, course_id, command, request),
    )


@router.delete("/teacher/classes/{course_id}")
def delete_class(
    course_id: UUID,
    request: Request,
    session: Database,
    user: CurrentUser,
    key: IdempotencyKey,
):
    return _write(
        session,
        request,
        user,
        key,
        f"teacher.class.delete:{course_id}",
        {"course_id": str(course_id)},
        lambda: service.delete_class(session, user, course_id, request),
    )
