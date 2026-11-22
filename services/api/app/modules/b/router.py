"""Real B course, group, project, and teacher platform entry points."""

from fastapi import APIRouter

from app.modules.b.courses_router import router as courses_router
from app.modules.b.groups_router import router as groups_router
from app.modules.b.manage_router import router as manage_router
from app.modules.b.membership_router import router as membership_router
from app.modules.b.milestones_router import router as milestones_router
from app.modules.b.planning_router import router as planning_router
from app.modules.b.projects_router import router as projects_router
from app.modules.b.requirements_router import router as requirements_router
from app.modules.b.tasks_view_router import router as tasks_view_router
from app.modules.b.teacher_actions_router import router as teacher_actions_router
from app.modules.b.teacher_announcements_router import router as teacher_announcements_router
from app.modules.b.teacher_appeals_router import router as teacher_appeals_router
from app.modules.b.teacher_classes_router import router as teacher_classes_router
from app.modules.b.teacher_dashboard_router import router as teacher_dashboard_router
from app.modules.b.teacher_files_router import router as teacher_files_router
from app.modules.b.teacher_projects_router import router as teacher_projects_router
from app.modules.b.teacher_reports_router import router as teacher_reports_router
from app.modules.b.teacher_rules_router import router as teacher_rules_router
from app.modules.b.teacher_staff_router import router as teacher_staff_router

router = APIRouter(tags=["b"])


@router.get("/api/b/ready", include_in_schema=False)
def ready() -> dict[str, str]:
    return {"module": "b", "status": "ready"}


router.include_router(courses_router, prefix="/api/v1")
router.include_router(groups_router, prefix="/api/v1")
router.include_router(projects_router, prefix="/api/v1")
router.include_router(requirements_router, prefix="/api/v1")
router.include_router(manage_router, prefix="/api/v1")
router.include_router(planning_router, prefix="/api/v1")
router.include_router(tasks_view_router, prefix="/api/v1")
router.include_router(milestones_router, prefix="/api/v1")
router.include_router(membership_router, prefix="/api/v1")
router.include_router(teacher_actions_router, prefix="/api/v1")
router.include_router(teacher_announcements_router, prefix="/api/v1")
router.include_router(teacher_appeals_router, prefix="/api/v1")
router.include_router(teacher_classes_router, prefix="/api/v1")
router.include_router(teacher_dashboard_router, prefix="/api/v1")
router.include_router(teacher_files_router, prefix="/api/v1")
router.include_router(teacher_projects_router, prefix="/api/v1")
router.include_router(teacher_reports_router, prefix="/api/v1")
router.include_router(teacher_rules_router, prefix="/api/v1")
router.include_router(teacher_staff_router, prefix="/api/v1")
