# ruff: noqa: E501
"""Isolated real FastAPI backend runner for full-lifecycle browser E2E verification.

Runs the real GroupProof FastAPI app (app.main:app) against a fresh isolated SQLite
database with seeded teacher + student leader + student member accounts, real cookie
sessions & CSRF validation, real inline material text extraction, real PDF/DOCX report
generation, and a deterministic multi-branch GitHub client (main + develop + PR + CI)
so Chromium exercises 100% real HTTP endpoints through Next.js without any browser
route mocking.
"""

from __future__ import annotations

import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[1]
API_DIR = REPO_ROOT / "services" / "api"
sys.path.insert(0, str(API_DIR))

os.environ["APP_ENV"] = "test"
os.environ["APP_MODE"] = "dev"
os.environ["AI_PROVIDER"] = "fake"
os.environ["REPORT_INLINE_MODE"] = "true"
os.environ["TEACHER_EMAIL_DOMAIN"] = "must.edu.mo"
os.environ["APP_ORIGIN"] = "http://127.0.0.1:13019"
os.environ["SUPABASE_URL"] = ""
os.environ["SUPABASE_SERVICE_ROLE_KEY"] = ""
os.environ["SUPABASE_STORAGE_BUCKET"] = ""

import atexit  # noqa: E402
import base64  # noqa: E402
import tempfile  # noqa: E402

import uvicorn  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import JSON, DefaultClause, MetaData, create_engine, event  # noqa: E402
from sqlalchemy.dialects.postgresql import JSONB  # noqa: E402
from sqlalchemy.orm import Mapper, Session, sessionmaker  # noqa: E402

from app.auth import db as auth_db  # noqa: E402
from app.auth.models import (  # noqa: E402
    PasswordCredential,
    SchoolEmailBinding,
    TeacherApplication,
)
from app.auth.security import hash_password  # noqa: E402
from app.db import session as db_session  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db.models import User  # noqa: E402
from app.db.session import get_session  # noqa: E402
from app.main import app  # noqa: E402
from app.modules.a import github  # noqa: E402


class _DemoMultiBranchGithub:
    def close(self) -> None:
        return None

    def installation_for_repo(self, owner: str, repo: str) -> int:
        return 7001

    def repo_info(self, owner: str, repo: str, installation_id: int) -> dict:
        return {
            "full_name": f"{owner}/{repo}",
            "default_branch": "main",
            "private": False,
        }

    def tree(self, owner: str, repo: str, ref: str, installation_id: int) -> dict:
        return {
            "tree": [
                {
                    "path": "README.md",
                    "type": "blob",
                    "sha": "blob-readme-1",
                    "size": 32,
                }
            ],
            "truncated": False,
        }

    def blob(self, owner: str, repo: str, sha: str, installation_id: int) -> bytes:
        return b"# GroupProof Student Demo Repo\n"

    def branches(self, owner: str, repo: str, installation_id: int) -> list[dict]:
        return [{"name": "main"}, {"name": "develop"}]

    def commits(
        self, owner: str, repo: str, branch: str, installation_id: int, *, per_page: int = 100
    ) -> list[dict]:
        now = datetime.now(UTC)
        if branch == "develop":
            return [
                {
                    "sha": "dev99887766554433221100",
                    "html_url": f"https://github.com/{owner}/{repo}/commit/dev99887766554433221100",
                    "commit": {
                        "message": "feat(student): polish workspace canvas and add direct GitHub sync",
                        "author": {
                            "name": "卓子杰",
                            "email": "leader@student.must.edu.mo",
                            "date": (now - timedelta(minutes=15)).isoformat(),
                        },
                    },
                    "author": {"id": 9001, "login": "ZZJ1977"},
                }
            ]
        return [
            {
                "sha": "main11223344556677889900",
                "html_url": f"https://github.com/{owner}/{repo}/commit/main11223344556677889900",
                "commit": {
                    "message": "Merge branch 'develop' into main",
                    "author": {
                        "name": "卓子杰",
                        "email": "leader@student.must.edu.mo",
                        "date": (now - timedelta(minutes=30)).isoformat(),
                    },
                },
                "author": {"id": 9001, "login": "ZZJ1977"},
            }
        ]

    def commit_detail(self, owner: str, repo: str, sha: str, installation_id: int) -> dict:
        return {
            "sha": sha,
            "stats": {"additions": 42, "deletions": 8, "total": 50},
            "files": [
                {
                    "filename": "features/c/ActivityApiPages.tsx",
                    "status": "modified",
                    "additions": 42,
                    "deletions": 8,
                    "patch": "@@ -1,3 +1,5 @@\n+direct sync button\n",
                }
            ],
        }

    def pulls(self, owner: str, repo: str, installation_id: int) -> list[dict]:
        now = datetime.now(UTC)
        return [
            {
                "number": 88,
                "title": "学生端开放画布与多分支同步闭环",
                "body": "## 变更说明\n<!-- 自动模板注释不应污染列表 -->\n优化学生端所有核心页面的视觉与交互闭环。\n\n## 验收清单\n- [x] 通过全流程交互测试",
                "state": "open",
                "merged_at": None,
                "draft": False,
                "html_url": f"https://github.com/{owner}/{repo}/pull/88",
                "user": {"id": 9001, "login": "ZZJ1977"},
                "head": {"ref": "develop"},
                "base": {"ref": "main"},
                "created_at": (now - timedelta(hours=2)).isoformat(),
                "updated_at": (now - timedelta(minutes=10)).isoformat(),
            }
        ]

    def workflow_runs(self, owner: str, repo: str, installation_id: int) -> list[dict]:
        now = datetime.now(UTC)
        return [
            {
                "id": 99001,
                "name": "CI/CD",
                "run_number": 231,
                "status": "completed",
                "conclusion": "success",
                "head_branch": "develop",
                "head_sha": "dev99887766554433221100",
                "event": "push",
                "html_url": f"https://github.com/{owner}/{repo}/actions/runs/99001",
                "actor": {"id": 9001, "login": "ZZJ1977"},
                "created_at": (now - timedelta(minutes=8)).isoformat(),
            }
        ]

    def commit_exists(self, owner: str, repo: str, sha: str, installation_id: int) -> bool:
        return True

    def run_exists(self, owner: str, repo: str, run_id: str, installation_id: int) -> bool:
        return True


def _build_engine():
    fd, db_path = tempfile.mkstemp(prefix="gp_student_e2e_", suffix=".db")
    os.close(fd)
    atexit.register(lambda: os.path.exists(db_path) and os.unlink(db_path))
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )

    @event.listens_for(engine, "connect")
    def _on_connect(conn, _):
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=1000")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.create_function("gen_random_uuid", 0, lambda: uuid4().hex)
        conn.create_function("to_regclass", 1, lambda _name: None)

    @event.listens_for(Mapper, "load")
    @event.listens_for(Mapper, "refresh")
    def _restore_utc(target, _context, *_args):
        for col in target.__table__.columns:
            val = getattr(target, col.key, None)
            if isinstance(val, datetime) and val.tzinfo is None:
                setattr(target, col.key, val.replace(tzinfo=UTC))

    @event.listens_for(Mapper, "before_insert")
    def _fill_defaults(_, __, target):
        now = datetime.now(UTC)
        for col in target.__table__.columns:
            if getattr(target, col.key, None) is not None:
                continue
            if col.primary_key and col.type.python_type is type(uuid4()):
                setattr(target, col.key, uuid4())
            elif not col.nullable and col.type.python_type is datetime:
                setattr(target, col.key, now)

    meta = MetaData()
    for table in Base.metadata.tables.values():
        clone = table.to_metadata(meta)
        for col in clone.columns:
            if isinstance(col.type, JSONB):
                col.type = JSON()
            if isinstance(col.server_default, DefaultClause):
                raw = str(col.server_default.arg)
                if "gen_random_uuid" in raw or "::jsonb" in raw or "now()" in raw:
                    col.server_default = None
    meta.create_all(engine)
    return engine


def _create_account(
    session: Session,
    *,
    name: str,
    username: str,
    email: str,
    password: str,
    role: str,
    student_id: str | None = None,
) -> User:
    now = datetime.now(UTC)
    user = User(
        id=uuid4(),
        name=name,
        username=username,
        username_normalized=username.lower(),
        email=email,
        student_id=student_id,
        college="创新工程学院",
        global_role=role,
        requested_identity="teacher" if role == "teacher" else "student",
        status="active",
        email_verified_at=now,
        preferred_locale="zh-Hans",
        auth_version=1,
        lock_version=0,
    )
    session.add(user)
    session.flush()
    session.add(
        PasswordCredential(
            user_id=user.id,
            login_email=email,
            login_email_normalized=email.lower(),
            login_email_verified_at=now,
            verification_evidence_ref="e2e_seed",
            credential_version=1,
            password_hash=hash_password(password),
            password_algo="argon2id",
            created_at=now,
            password_changed_at=now,
        )
    )
    session.add(
        SchoolEmailBinding(
            user_id=user.id,
            school_email=email,
            school_email_normalized=email.lower(),
            verified_at=now,
            verification_method="documented_manual_review",
        )
    )
    if role == "teacher":
        session.add(
            TeacherApplication(
                id=uuid4().hex,
                user_id=user.id,
                application_version=0,
                snapshot={
                    "name": name,
                    "requestedIdentity": "teacher",
                    "schoolEmailNormalized": email.lower(),
                },
                status="approved",
                reviewed_at=now,
                reason="e2e seed approved",
                created_at=now,
            )
        )
    session.flush()
    return user


def main() -> None:
    engine = _build_engine()
    SessionLocal = sessionmaker(
        bind=engine, autoflush=False, autocommit=False, expire_on_commit=False
    )

    # Wire real app dependencies (Auth + A + B + C + D) to our isolated DB & deterministic GitHub client
    db_session.engine = engine
    db_session.SessionLocal = SessionLocal
    auth_db.SessionLocal = SessionLocal

    def _override_session():
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def _override_auth_db():
        db = SessionLocal()
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    app.dependency_overrides[get_session] = _override_session
    app.dependency_overrides[auth_db.get_db] = _override_auth_db
    github.get_github_client = lambda: _DemoMultiBranchGithub()

    # Seed teacher, student leader, student member, and an active course via real HTTP API
    with SessionLocal() as db:
        _create_account(
            db,
            name="陈教授",
            username="e2e_teacher",
            email="teacher@must.edu.mo",
            password="Password123!",
            role="teacher",
        )
        leader = _create_account(
            db,
            name="卓子杰",
            username="e2e_leader",
            email="leader@student.must.edu.mo",
            password="Password123!",
            role="student",
            student_id="1240025428",
        )
        member = _create_account(
            db,
            name="李同学",
            username="e2e_member",
            email="member@student.must.edu.mo",
            password="Password123!",
            role="student",
            student_id="1240025429",
        )
        db.commit()
        leader_id = str(leader.id)
        member_id = str(member.id)

    with TestClient(app) as tc:
        login_res = tc.post(
            "/api/v1/auth/password/login",
            json={"identifier": "teacher@must.edu.mo", "password": "Password123!"},
        )
        assert login_res.status_code == 200, login_res.text
        sess_res = tc.get("/api/v1/auth/session")
        csrf = sess_res.json()["data"]["csrfToken"]
        headers = {"X-CSRF-Token": csrf, "Origin": os.environ["APP_ORIGIN"]}
        deadline = (datetime.now(UTC) + timedelta(days=45)).isoformat()
        created = tc.post(
            "/api/v1/teacher/classes",
            headers={**headers, "Idempotency-Key": str(uuid4())},
            json={
                "code": "SE301",
                "name": "软件工程实践（2026秋）",
                "semester": "2026-Fall",
                "college": "创新工程学院",
                "grouping_mode": "free",
                "min_group_size": 1,
                "max_group_size": 5,
                "project_deadline": deadline,
            },
        )
        assert created.status_code == 201, created.text
        course_data = created.json()["data"]
        course_id = course_data["id"]
        invite_code = course_data["invite_code"]
        pub = tc.post(
            f"/api/v1/teacher/classes/{course_id}/rules/publish",
            headers={**headers, "Idempotency-Key": str(uuid4())},
            json={"change_summary": "发布本学期正式课程规则"},
        )
        assert pub.status_code in (200, 201), pub.text
        syllabus = (
            "# 课程实训大纲\n1. 完成需求基线冻结\n2. 完成任务验收、贡献冻结与结项报告".encode()
        )
        up = tc.post(
            f"/api/v1/teacher/classes/{course_id}/files/upload",
            headers={**headers, "Idempotency-Key": str(uuid4())},
            json={
                "name": "课程实训大纲-v1.md",
                "visibility": "all",
                "status": "published",
                "mime_type": "text/markdown",
                "size_bytes": len(syllabus),
                "content_base64": base64.b64encode(syllabus).decode(),
                "change_note": "首版教学大纲",
            },
        )
        assert up.status_code in (200, 201), up.text

    seed_info = {
        "course_id": str(course_id),
        "invite_code": invite_code,
        "leader_id": leader_id,
        "leader_email": "leader@student.must.edu.mo",
        "leader_password": "Password123!",
        "member_id": member_id,
        "member_email": "member@student.must.edu.mo",
        "member_password": "Password123!",
    }

    # Expose a test-only seed metadata endpoint so the Playwright script knows the invite code
    @app.get("/api/e2e/seed-info", include_in_schema=False)
    def _seed_info():
        return seed_info

    print(
        f"E2E_BACKEND_READY course={seed_info['course_id']} invite={seed_info['invite_code']}",
        flush=True,
    )
    uvicorn.run(app, host="127.0.0.1", port=18019, log_level="warning")


if __name__ == "__main__":
    main()
