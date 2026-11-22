"""Independent project starts with no courses and retains student workspace APIs."""

from datetime import UTC, date, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models import CourseMember, Project, ProjectMember
from tests.b_fixtures import _user, b_api, b_postgres_schema, b_test_database_url


def test_independent_project_without_course_can_open_and_edit_workspace(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    with b_postgres_schema(b_test_database_url()) as engine:
        with Session(engine) as session:
            user = _user(
                session, tag=uuid4().hex[:8], role="student", index=1, now=datetime.now(UTC)
            )
            uid = user.id
            session.commit()
        with b_api(engine) as api:
            api.as_user(uid)
            created = api.post(
                "/api/v1/a/projects", {"name": "独立项目", "description": "没有课程"}
            )
            assert created.status_code == 201, created.text
            pid = created.json()["data"]["project_id"]
            base = f"/api/v1/projects/{pid}"
            for path in [
                "overview",
                "setup",
                "setup/requirements",
                "requirements",
                "plan",
                "tasks",
                "milestones",
                "c-context",
                "files",
                "discussions",
                "settings",
                "reopens",
            ]:
                response = api.get(f"{base}/{path}")
                assert response.status_code == 200, (path, response.text)
            setup = api.get(f"{base}/setup").json()["data"]
            saved = api.patch(
                f"{base}/setup/basic",
                {
                    "name": "独立项目改名",
                    "start_date": str(date.today()),
                    "end_date": str(date.today() + timedelta(days=30)),
                    "expected_version": setup["lock_version"],
                },
            )
            assert saved.status_code == 200, saved.text
        with Session(engine) as session:
            project = session.get(Project, UUID(pid))
            assert project.course_id is None and project.group_id is None
            assert session.scalar(select(func.count()).select_from(CourseMember)) == 0
            assert (
                session.scalar(
                    select(ProjectMember.role).where(
                        ProjectMember.project_id == project.id, ProjectMember.user_id == uid
                    )
                )
                == "leader"
            )
