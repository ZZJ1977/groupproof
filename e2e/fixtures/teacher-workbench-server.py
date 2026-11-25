"""Isolated real-backend FastAPI server for Teacher Workbench E2E (TW_E2E_MODE=real).

Auto-detects ``backend/api`` or ``services/api``, supports isolated PostgreSQL schema
via ``TW_E2E_DATABASE_URL`` or SQLite fallback via ``TW_E2E_SQLITE=1``, mounts the
unmodified production FastAPI app (``app.main:app``), and exposes loopback-only
``GET /__test/health`` and ``POST /__test/seed`` endpoints.
"""

from __future__ import annotations

import atexit
import hmac
import os
import re
import shutil
import sys
import tempfile
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request
from sqlalchemy import JSON, DefaultClause, MetaData, create_engine, event, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Mapper

APP_ENV = os.getenv("APP_ENV", "test")
if APP_ENV in {"production", "staging", "real"}:
    raise RuntimeError(f"teacher-workbench-server.py refuses to run under APP_ENV={APP_ENV!r}")

REPO_ROOT = Path(__file__).resolve().parents[2]
API_ROOT = next(
    (
        candidate
        for candidate in (REPO_ROOT / "services" / "api",)
        if (candidate / "app" / "main.py").is_file()
    ),
    None,
)
if API_ROOT is None:
    raise RuntimeError("Could not locate backend/api or services/api")

PORT = int(os.getenv("TW_E2E_PORT") or os.getenv("TW_AUTH_PORT") or "18009")
WEB_ORIGIN = os.getenv("TW_E2E_WEB_ORIGIN", "http://127.0.0.1:13009").rstrip("/")
CONTROL_TOKEN = os.getenv("TW_E2E_CONTROL_TOKEN", "")
RAW_DB_URL = (os.getenv("TW_E2E_DATABASE_URL") or "").strip()
USE_SQLITE = os.getenv("TW_E2E_SQLITE", "").strip() == "1" or not RAW_DB_URL

admin_engine = None
schema_name: str | None = None
sqlite_engine = None
sqlite_temp_dir: str | None = None
sqlite_url: str | None = None
cleanup_done = False


def _setup_environment(database_url: str) -> None:
    os.environ.update(
        APP_ENV="test",
        DATABASE_URL=database_url,
        GROUPPROOF_ENV_FILE=os.devnull,
        APP_MODE="dev",
        APP_ORIGIN=WEB_ORIGIN,
        API_INTERNAL_URL=f"http://127.0.0.1:{PORT}",
        ENABLE_DEMO_AUTH="false",
        MAIL_MODE="capture",
        EMAIL_CHALLENGE_HMAC_KEY="tw-e2e-isolated-test-only",
        AUTH_PASSWORD_ENABLED="true",
        AUTH_EMAIL_SIGNUP_ENABLED="true",
        AUTH_PASSWORD_RESET_ENABLED="true",
        NO_PROXY="127.0.0.1,localhost",
        no_proxy="127.0.0.1,localhost",
    )


if not USE_SQLITE:
    db_url = make_url(RAW_DB_URL)
    if db_url.get_backend_name() != "postgresql" or db_url.host not in {"127.0.0.1", "localhost"}:
        raise RuntimeError("TW_E2E_DATABASE_URL must point to loopback PostgreSQL")
    schema_name = f"tw_e2e_{uuid4().hex}"
    assert re.fullmatch(r"tw_e2e_[0-9a-f]{32}", schema_name)
    db_url = db_url.set(drivername="postgresql+psycopg")
    admin_engine = create_engine(db_url)
    with admin_engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema_name}"'))
    scoped_url = db_url.update_query_dict({"options": f"-csearch_path={schema_name}"})
    _setup_environment(scoped_url.render_as_string(hide_password=False))
else:
    sqlite_temp_dir = tempfile.mkdtemp(prefix="tw_e2e_sqlite_")
    sqlite_db_path = Path(sqlite_temp_dir) / "tw_e2e.sqlite3"
    sqlite_url = f"sqlite:///{sqlite_db_path}"
    _setup_environment(sqlite_url)

sys.path.insert(0, str(API_ROOT))

import app.db.session as db_session  # noqa: E402


def _ensure_tz(target: object, *_args: object) -> None:
    for key, val in list(vars(target).items()):
        if isinstance(val, datetime) and val.tzinfo is None:
            setattr(target, key, val.replace(tzinfo=UTC))


if USE_SQLITE:
    try:
        event.remove(db_session.engine, "connect", db_session.set_connection_timezone)
    except Exception:
        pass
    db_session.engine.dispose()

    assert sqlite_url is not None
    sqlite_engine = create_engine(
        sqlite_url,
        pool_size=20,
        max_overflow=20,
        pool_pre_ping=True,
        connect_args={"check_same_thread": False, "timeout": 30},
    )

    @event.listens_for(sqlite_engine, "connect")
    def _sqlite_on_connect(connection: Any, _record: object) -> None:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.create_function("gen_random_uuid", 0, lambda: uuid4().hex)
        connection.create_function("to_regclass", 1, lambda _name: None)

    event.listen(Mapper, "load", _ensure_tz)
    event.listen(Mapper, "refresh", _ensure_tz)

    db_session.engine = sqlite_engine
    db_session.SessionLocal.configure(bind=sqlite_engine)

from app.auth.models import (  # noqa: E402
    PasswordCredential,
    SchoolEmailBinding,
    TeacherApplication,
)
from app.auth.security import hash_password  # noqa: E402
from app.auth.services.registration import review_basis  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db.models import (  # noqa: E402
    Course,
    CourseMember,
    CourseStaff,
    User,
)
from app.main import app as production_app  # noqa: E402
from app.modules.a import models as _a_models  # noqa: E402, F401
from app.modules.b import models as _b_models  # noqa: E402, F401
from app.modules.c import (  # noqa: E402, F401
    activity_models as _c_activity_models,
    course_files_models as _c_course_files_models,
    discussion_models as _c_discussion_models,
    files_models as _c_files_models,
    governance_models as _c_governance_models,
    models as _c_models,
)
from app.modules.c.governance_models import CourseInvite  # noqa: E402
from app.modules.d import models as _d_models  # noqa: E402, F401
from app.modules.d.models import CourseRuleVersion  # noqa: E402

if USE_SQLITE:
    portable_meta = MetaData()
    for table in Base.metadata.sorted_tables:
        portable = table.to_metadata(portable_meta)
        for column in portable.columns:
            if isinstance(column.type, JSONB):
                column.type = JSON()
            if (
                column.server_default is not None
                and str(column.server_default.arg) == "gen_random_uuid()"
            ):
                column.server_default = DefaultClause(text("(gen_random_uuid())"))
    portable_meta.create_all(db_session.engine)
else:
    Base.metadata.create_all(db_session.engine)


def cleanup() -> None:
    global cleanup_done, schema_name, sqlite_temp_dir
    if cleanup_done:
        return
    cleanup_done = True
    try:
        db_session.engine.dispose()
    except Exception:
        pass
    if USE_SQLITE:
        try:
            event.remove(Mapper, "load", _ensure_tz)
            event.remove(Mapper, "refresh", _ensure_tz)
        except Exception:
            pass
        if sqlite_temp_dir is not None:
            shutil.rmtree(sqlite_temp_dir, ignore_errors=True)
            sqlite_temp_dir = None
    if admin_engine is not None and schema_name is not None:
        try:
            with admin_engine.begin() as connection:
                connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema_name}" CASCADE'))
            schema_name = None
        finally:
            admin_engine.dispose()


atexit.register(cleanup)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        yield
    finally:
        cleanup()


app = FastAPI(lifespan=lifespan)


def _require_control(request: Request) -> None:
    if request.client is None or request.client.host not in {"127.0.0.1", "::1"}:
        raise HTTPException(status_code=403, detail="Loopback only")
    if CONTROL_TOKEN:
        provided = (
            request.headers.get("x-tw-e2e-control")
            or request.headers.get("x-tw-control")
            or ""
        )
        if not hmac.compare_digest(provided, CONTROL_TOKEN):
            raise HTTPException(status_code=403, detail="Invalid control token")


@app.get("/__test/health")
def test_health() -> dict[str, Any]:
    return {
        "status": "ready",
        "isolated": True,
        "dialect": "sqlite" if USE_SQLITE else "postgresql",
        "api_root": str(API_ROOT.relative_to(REPO_ROOT)),
    }


def _create_active_user(
    db: Any,
    *,
    tag: str,
    key: str,
    name: str,
    role: str,
    requested_identity: str,
    email: str,
    password: str,
    student_id: str | None = None,
    now: datetime,
) -> tuple[User, dict[str, str]]:
    user = User(
        id=uuid4(),
        name=name,
        username=f"tw_{key}_{tag}",
        username_normalized=f"tw_{key}_{tag}".lower(),
        email=email,
        student_id=student_id,
        college="计算机科学与工程学院",
        requested_identity=requested_identity,
        preferred_locale="zh-Hans",
        global_role=role,
        status="active",
        email_verified_at=now,
    )
    db.add(user)
    db.flush()

    binding = SchoolEmailBinding(
        user_id=user.id,
        school_email=email,
        school_email_normalized=email.lower(),
        verified_at=now,
        verification_method="documented_manual_review",
    )
    db.add(binding)
    db.flush()

    if requested_identity == "teacher":
        db.add(
            TeacherApplication(
                id=uuid4().hex,
                user_id=user.id,
                application_version=user.lock_version,
                snapshot=review_basis(user, binding),
                status="approved",
                reviewer_id=user.id,
                reviewed_at=now,
                reason="E2E seeded active staff account",
            )
        )

    db.add(
        PasswordCredential(
            user_id=user.id,
            login_email=email,
            login_email_normalized=email.lower(),
            login_email_verified_at=now,
            credential_version=1,
            password_hash=hash_password(password),
            password_algo="argon2id",
        )
    )
    db.flush()

    return user, {
        "id": str(user.id),
        "name": name,
        "username": user.username or "",
        "email": email,
        "password": password,
        "role": role,
    }


@app.post("/__test/seed", dependencies=[Depends(_require_control)])
async def test_seed(request: Request) -> dict[str, Any]:
    """Seed active Teacher, TA, Student 1, and Student 2 accounts for /login tests."""
    payload: dict[str, Any] = {}
    try:
        raw = await request.body()
        if raw:
            import json

            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                payload = parsed
    except Exception:
        payload = {}

    default_password = str(payload.get("password") or "GroupProof#2026")
    with_course = bool(payload.get("with_course", False))
    tag = uuid4().hex[:8]
    now = datetime.now(UTC)

    with db_session.SessionLocal() as db:
        teacher, teacher_info = _create_active_user(
            db,
            tag=tag,
            key="teacher",
            name="张老师",
            role="teacher",
            requested_identity="teacher",
            email=f"tw_teacher_{tag}@must.edu.mo",
            password=default_password,
            now=now,
        )
        ta, ta_info = _create_active_user(
            db,
            tag=tag,
            key="ta",
            name="陈助教",
            role="ta",
            requested_identity="teacher",
            email=f"tw_ta_{tag}@must.edu.mo",
            password=default_password,
            now=now,
        )
        student1, student1_info = _create_active_user(
            db,
            tag=tag,
            key="stu1",
            name="李同学",
            role="student",
            requested_identity="student",
            email=f"tw_stu1_{tag}@student.must.edu.mo",
            student_id=f"2026{tag[:6]}01",
            password=default_password,
            now=now,
        )
        _student2, student2_info = _create_active_user(
            db,
            tag=tag,
            key="stu2",
            name="赵同学",
            role="student",
            requested_identity="student",
            email=f"tw_stu2_{tag}@student.must.edu.mo",
            student_id=f"2026{tag[:6]}02",
            password=default_password,
            now=now,
        )

        course_info: dict[str, Any] | None = None
        if with_course:
            course = Course(
                id=uuid4(),
                owner_id=teacher.id,
                code=f"SE-{tag.upper()}",
                name=f"软件工程实践 {tag}",
                college="计算机科学与工程学院",
                semester="2026-Autumn",
                status="active",
                formation_deadline=now + timedelta(days=14),
                project_deadline=now + timedelta(days=90),
                grouping_mode="free",
                min_group_size=1,
                max_group_size=5,
            )
            db.add(course)
            db.flush()

            invite_code = f"TW-{tag.upper()}-{uuid4().hex[:12].upper()}"
            db.add(CourseInvite(course_id=course.id, code=invite_code, created_by=teacher.id))
            db.add(
                CourseRuleVersion(
                    course_id=course.id,
                    version_no=1,
                    actor_id=teacher.id,
                    reason="Initial E2E course rules",
                    effective_at=now,
                    rules={
                        "settings": {
                            "min_group_size": course.min_group_size,
                            "max_group_size": course.max_group_size,
                            "project_deadline": course.project_deadline.isoformat()
                            if course.project_deadline
                            else None,
                        }
                    },
                )
            )
            db.add_all(
                [
                    CourseStaff(course_id=course.id, user_id=teacher.id, role="teacher"),
                    CourseStaff(
                        course_id=course.id,
                        user_id=ta.id,
                        role="ta",
                        permissions={
                            "approve_joins": True,
                            "manage_groups": True,
                            "manage_files": False,
                            "approve_changes": False,
                            "export_reports": True,
                            "post_announcements": False,
                        },
                    ),
                    CourseMember(course_id=course.id, user_id=teacher.id, role="teacher"),
                    CourseMember(course_id=course.id, user_id=student1.id, role="student"),
                ]
            )
            course_info = {
                "id": str(course.id),
                "code": course.code,
                "name": course.name,
                "invite_code": invite_code,
            }

        db.commit()

    result: dict[str, Any] = {
        "users": {
            "teacher": teacher_info,
            "ta": ta_info,
            "student1": student1_info,
            "student2": student2_info,
        }
    }
    if course_info is not None:
        result["course"] = course_info
    return result


app.mount("/", production_app)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, access_log=False)
