"""B-owned API boundary.

Topic routers (courses_*, groups_*, projects_*, requirements_*, planning_*,
milestones_*) are added stage by stage and included here so main.py keeps a
single B entry point.
"""

from fastapi import APIRouter

from app.modules.b.courses_router import router as courses_router

router = APIRouter(tags=["b"])

ready_router = APIRouter(prefix="/api/b", tags=["b"])


@ready_router.get("/ready", include_in_schema=False)
def ready() -> dict[str, str]:
    return {"module": "b", "status": "ready"}


router.include_router(ready_router)
router.include_router(courses_router, prefix="/api/v1")
