from fastapi import APIRouter

from app.modules.c.admin_users_router import router as admin_users_router
from app.modules.c.discussion_router import router as discussion_router
from app.modules.c.evidence_router import router as evidence_router
from app.modules.c.execution_router import router as execution_router
from app.modules.c.note_router import router as note_router

router = APIRouter(tags=["c"])


@router.get("/api/c/ready", include_in_schema=False)
def ready() -> dict[str, str]:
    return {"module": "c", "status": "ready"}


router.include_router(execution_router, prefix="/api/v1")
router.include_router(evidence_router, prefix="/api/v1")
router.include_router(note_router, prefix="/api/v1")
router.include_router(discussion_router, prefix="/api/v1")
router.include_router(admin_users_router, prefix="/api/v1")
