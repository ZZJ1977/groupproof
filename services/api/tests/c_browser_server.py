"""Isolated network harness for C browser integration, never a production entry point.

Only the OIDC issuer and initial fixtures are test doubles. Business requests use
the unmodified app, session/CSRF checks and committed PostgreSQL transactions.
The random schema is built from ORM metadata, not a migration acceptance test.
"""

from __future__ import annotations

import atexit
import base64
import hmac
import html
import json
import os
import re
import sys
import threading
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from http.server import HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, HTTPException, Request
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url

if os.getenv("APP_ENV") != "test" or os.getenv("C_BROWSER_TEST") != "1":
    raise RuntimeError("C browser harness requires APP_ENV=test and C_BROWSER_TEST=1")
control_token = os.environ.get("C_BROWSER_CONTROL_TOKEN", "")
if len(control_token) < 32:
    raise RuntimeError("Provide a random C_BROWSER_CONTROL_TOKEN of at least 32 characters")
database = make_url(os.environ["C_BROWSER_DATABASE_URL"])
if database.get_backend_name() != "postgresql" or database.host not in {"127.0.0.1", "localhost"}:
    raise RuntimeError("C_BROWSER_DATABASE_URL must explicitly name loopback PostgreSQL")
schema = f"c_browser_{uuid4().hex}"
assert re.fullmatch(r"c_browser_[0-9a-f]{32}", schema)
database = database.set(drivername="postgresql+psycopg")
admin_engine = create_engine(database)
schema_created = False
issuer: HTTPServer | None = None
issuer_thread: threading.Thread | None = None
business_engine = None
cleanup_lock = threading.Lock()


def cleanup():
    """Also runs after failed imports/table creation, before ASGI lifespan starts."""
    global issuer, business_engine, schema_created
    with cleanup_lock:
        try:
            if issuer is not None:
                if issuer_thread is not None and issuer_thread.is_alive():
                    issuer.shutdown()
                    issuer_thread.join(timeout=5)
                issuer.server_close()
                issuer = None
        finally:
            try:
                if business_engine is not None:
                    business_engine.dispose()
                    business_engine = None
            finally:
                try:
                    if schema_created:
                        with admin_engine.begin() as connection:
                            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
                        schema_created = False
                finally:
                    admin_engine.dispose()


atexit.register(cleanup)
with admin_engine.begin() as connection:
    connection.execute(text(f'CREATE SCHEMA "{schema}"'))
schema_created = True
scoped_database = database.update_query_dict({"options": f"-csearch_path={schema}"})
web_origin = "http://127.0.0.1:13007"
os.environ.update(
    DATABASE_URL=scoped_database.render_as_string(hide_password=False),
    GROUPPROOF_ENV_FILE=os.devnull,
    APP_MODE="dev",  # Loopback HTTP cookies; no demo identity or business mocks.
    APP_ORIGIN=web_origin,
    ENABLE_DEMO_AUTH="false",
    MAIL_MODE="capture",
    EMAIL_CHALLENGE_HMAC_KEY="c-browser-isolated-test-only",
    AUTH_GOOGLE_ENABLED="true",
    GOOGLE_CLIENT_ID="test-client-id",
    GOOGLE_CLIENT_SECRET="c-browser-test-secret",
    GOOGLE_REDIRECT_URI=f"{web_origin}/api/v1/auth/google/callback",
    NO_PROXY="127.0.0.1,localhost",
    no_proxy="127.0.0.1,localhost",
)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import oidc_stub  # noqa: E402

actors: dict[str, dict] = {}


class BrowserIssuerHandler(oidc_stub._Handler):
    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/authorize":
            return super().do_GET()
        query = parse_qs(parsed.query)
        required = ("state", "nonce", "code_challenge", "redirect_uri", "client_id")
        if any(len(query.get(key, [])) != 1 for key in required):
            return self._send(400, {"error": "invalid_request"})
        if query["redirect_uri"][0] != f"{web_origin}/api/v1/auth/google/callback":
            return self._send(400, {"error": "invalid_redirect_uri"})
        if query["client_id"][0] != oidc_stub.CLIENT_ID:
            return self._send(400, {"error": "invalid_client"})
        account = query.get("account", [None])[0]
        if account is None:
            hidden = "".join(
                f'<input type="hidden" name="{html.escape(key)}" value="{html.escape(values[0])}">'
                for key, values in query.items()
            )
            buttons = "".join(
                f'<button name="account" value="{key}">{html.escape(value["name"])}</button>'
                for key, value in actors.items()
            )
            body = f"<h1>Isolated OIDC test issuer</h1><form>{hidden}{buttons}</form>".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return None
        if account not in actors:
            return self._send(400, {"error": "invalid_account"})
        actor = actors[account]
        payload = {
            "sub": actor["subject"],
            "email": actor["email"],
            "name": actor["name"],
            "email_verified": True,
            "nonce": query["nonce"][0],
            "code_challenge": query["code_challenge"][0],
        }
        code = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
        location = (
            query["redirect_uri"][0] + "?" + urlencode({"state": query["state"][0], "code": code})
        )
        self.send_response(302)
        self.send_header("Location", location)
        self.end_headers()
        return None


issuer = HTTPServer(("127.0.0.1", 0), BrowserIssuerHandler)
oidc_stub.ISSUER = f"http://127.0.0.1:{issuer.server_port}"
issuer_thread = threading.Thread(target=issuer.serve_forever, daemon=True)
issuer_thread.start()
os.environ["GOOGLE_DISCOVERY_URL"] = f"{oidc_stub.ISSUER}/.well-known/openid-configuration"
os.environ["GOOGLE_EXPECTED_ISSUER"] = oidc_stub.ISSUER

from app.auth.models import AuthAuditEvent, AuthIdentity, SchoolEmailBinding  # noqa: E402
from app.auth.models import Session as AuthSession  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db.models import (  # noqa: E402
    AcceptanceCriterion,
    Course,
    FunctionalModule,
    PlanVersion,
    ProgressEvent,
    Project,
    ProjectMember,
    Task,
    TaskAssignee,
    User,
)
from app.db.session import SessionLocal, engine  # noqa: E402

business_engine = engine

from app.main import app as production_app  # noqa: E402
from app.modules.c.models import (  # noqa: E402
    Evidence,
    EvidenceCriterion,
    EvidenceSourceSnapshot,
    TaskNote,
    TaskNoteVersion,
)

Base.metadata.create_all(engine)


@asynccontextmanager
async def lifespan(_app):
    try:
        yield
    finally:
        cleanup()


app = FastAPI(lifespan=lifespan)


def control(request: Request):
    if request.client is None or request.client.host not in {"127.0.0.1", "::1"}:
        raise HTTPException(403)
    if not hmac.compare_digest(request.headers.get("x-c-browser-control", ""), control_token):
        raise HTTPException(403)


@app.get("/__test/health")
def healthy():
    return {"status": "ready", "isolated": True}


@app.post("/__test/seed", dependencies=[Depends(control)])
def seed():
    """Create only synthetic pre-existing users/plans; never issue or inject sessions."""
    current = {}
    with SessionLocal() as db:
        for kind, name, role in (
            ("member", "浏览器联调成员", "student"),
            ("outsider", "浏览器联调外组成员", "student"),
            ("admin", "浏览器联调管理员", "admin"),
        ):
            identity = uuid4()
            email = f"c{identity.hex}@{'student.' if role == 'student' else ''}must.edu.mo"
            user = User(
                id=identity,
                name=name,
                username=f"c{identity.hex[:16]}",
                email=email,
                college="Browser test",
                requested_identity="student" if role == "student" else None,
                student_id=str(identity.int % 10**18).zfill(18) if role == "student" else None,
                global_role=role,
                status="active",
                email_binding=SchoolEmailBinding(
                    school_email=email,
                    school_email_normalized=email,
                    verified_at=datetime.now(UTC),
                    verification_method="documented_manual_review",
                ),
            )
            db.add(user)
            db.flush()
            subject = f"browser-{identity.hex}"
            db.add(
                AuthIdentity(
                    id=uuid4().hex,
                    provider="google",
                    issuer=oidc_stub.ISSUER,
                    subject=subject,
                    user_id=identity,
                    google_email=email,
                )
            )
            current[kind] = {"id": str(identity), "name": name, "email": email, "subject": subject}
        course = Course(
            id=uuid4(),
            owner_id=UUID(current["admin"]["id"]),
            code=uuid4().hex,
            name="Browser integration course",
            college="Browser test",
            semester="2026",
            status="active",
        )
        db.add(course)
        db.flush()
        project = Project(
            id=uuid4(),
            course_id=course.id,
            name="浏览器真实联调项目",
            lifecycle="active",
            setup_status="frozen",
        )
        db.add(project)
        db.flush()
        module = FunctionalModule(id=uuid4(), project_id=project.id, name="Browser module")
        db.add(module)
        db.flush()
        task = Task(
            id=uuid4(),
            project_id=project.id,
            module_id=module.id,
            title="浏览器真实执行任务",
            description="真实登录后通过代理保存到 PostgreSQL。",
            status="not_started",
            progress_percent=0,
            weight=1,
        )
        db.add(task)
        db.flush()
        member_id = UUID(current["member"]["id"])
        criterion = AcceptanceCriterion(
            id=uuid4(),
            task_id=task.id,
            criterion_key="AC-browser",
            text="刷新后保留原始证据",
        )
        db.add_all(
            [
                criterion,
                ProjectMember(id=uuid4(), project_id=project.id, user_id=member_id, role="leader"),
                TaskAssignee(task_id=task.id, user_id=member_id, role="responsible"),
                PlanVersion(
                    id=uuid4(),
                    project_id=project.id,
                    version_no=1,
                    created_by=member_id,
                    status="frozen",
                    snapshot_json={"tasks": [str(task.id)]},
                ),
            ]
        )
        db.commit()
        actors.clear()
        actors.update(current)
        return {
            "project": str(project.id),
            "task": str(task.id),
            "criterion": str(criterion.id),
            "users": current,
        }


@app.get("/__test/state/{project_id}", dependencies=[Depends(control)])
def state(project_id: UUID):
    """Independent committed database read; no business response substitution."""
    with SessionLocal() as db:
        task = db.scalar(select(Task).where(Task.project_id == project_id))
        if task is None:
            raise HTTPException(404)
        note = db.scalar(select(TaskNote).where(TaskNote.task_id == task.id))
        versions = (
            list(
                db.scalars(
                    select(TaskNoteVersion)
                    .where(TaskNoteVersion.note_id == note.id)
                    .order_by(TaskNoteVersion.version_no, TaskNoteVersion.id)
                )
            )
            if note
            else []
        )
        evidence = list(db.scalars(select(Evidence).where(Evidence.project_id == project_id)))
        evidence_ids = [row.id for row in evidence]
        snapshots = list(
            db.scalars(
                select(EvidenceSourceSnapshot).where(
                    EvidenceSourceSnapshot.evidence_id.in_(evidence_ids)
                )
            )
        )
        criteria = list(
            db.scalars(
                select(EvidenceCriterion.criterion_id).where(
                    EvidenceCriterion.evidence_id.in_(evidence_ids)
                )
            )
        )
        progress = list(
            db.scalars(
                select(ProgressEvent)
                .where(ProgressEvent.task_id == task.id)
                .order_by(ProgressEvent.created_at)
            )
        )
        member = db.get(User, UUID(actors["member"]["id"]))
        sessions = list(db.scalars(select(AuthSession).where(AuthSession.user_id == member.id)))
        events = list(
            db.scalars(
                select(AuthAuditEvent).where(AuthAuditEvent.target_user_id == str(member.id))
            )
        )
        return {
            "task": {
                "status": task.status,
                "progress": task.progress_percent,
                "version": task.lock_version,
            },
            "notes": [
                {"title": row.title, "body": row.body, "version": row.version_no}
                for row in versions
            ],
            "evidence": [
                {
                    "id": str(row.id),
                    "title": row.title,
                    "status": row.status,
                    "author": str(row.author_id),
                }
                for row in evidence
            ],
            "snapshots": [
                {"hash": row.content_hash, "content": row.content_json} for row in snapshots
            ],
            "criteria": [str(value) for value in criteria],
            "progress": [
                {"reason": row.reason, "actor": str(row.actor_id), "after": row.progress_after}
                for row in progress
            ],
            "member": {"id": str(member.id), "status": member.status},
            "sessions": [
                {"method": row.auth_method, "revoked": row.revoked_at is not None}
                for row in sessions
            ],
            "audit": [row.event_type for row in events],
        }


app.mount("/", production_app)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=18007, access_log=False)
