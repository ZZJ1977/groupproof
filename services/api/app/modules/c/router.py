from fastapi import APIRouter

from app.modules.c.activity_router import router as activity_router
from app.modules.c.admin_users_router import router as admin_users_router
from app.modules.c.auth_audit_router import router as auth_audit_router
from app.modules.c.context_router import router as context_router
from app.modules.c.course_files_router import router as course_files_router
from app.modules.c.daily_router import router as daily_router
from app.modules.c.discussion_router import router as discussion_router
from app.modules.c.evidence_router import router as evidence_router
from app.modules.c.execution_history_router import router as execution_history_router
from app.modules.c.execution_router import router as execution_router
from app.modules.c.files_router import router as files_router
from app.modules.c.governance_read_router import router as governance_read_router
from app.modules.c.governance_router import router as governance_router
from app.modules.c.inbox_router import router as inbox_router
from app.modules.c.note_router import router as note_router

router = APIRouter(tags=["c"])


@router.get("/api/c/ready", include_in_schema=False)
def ready() -> dict[str, str]:
    return {"module": "c", "status": "ready"}


router.include_router(execution_router, prefix="/api/v1")
router.include_router(execution_history_router, prefix="/api/v1")
router.include_router(evidence_router, prefix="/api/v1")
router.include_router(note_router, prefix="/api/v1")
router.include_router(discussion_router, prefix="/api/v1")
router.include_router(admin_users_router, prefix="/api/v1")
router.include_router(auth_audit_router, prefix="/api/v1")
router.include_router(daily_router, prefix="/api/v1")
router.include_router(activity_router, prefix="/api/v1")
router.include_router(files_router, prefix="/api/v1")
router.include_router(context_router, prefix="/api/v1")
router.include_router(course_files_router, prefix="/api/v1")
router.include_router(governance_router, prefix="/api/v1")
router.include_router(governance_read_router, prefix="/api/v1")
router.include_router(inbox_router, prefix="/api/v1")
