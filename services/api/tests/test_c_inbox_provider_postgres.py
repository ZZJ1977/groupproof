"""Check C's HTTP routes with A4's actual default provider, cookies and PostgreSQL."""

import os
from importlib.util import find_spec
from uuid import uuid4

import pytest
import test_c_auth_verification_integration as identity_tests

from app.db.models import CourseMember, TaskAssignee
from app.modules.c.daily_router import router as daily_router
from app.modules.c.inbox_router import router as inbox_router

db = identity_tests.db
scope = identity_tests.scope
http = identity_tests.http

pytestmark = [
    pytest.mark.skipif(
        find_spec("app.modules.a.inbox") is None, reason="A4 inbox provider is not installed"
    ),
    pytest.mark.skipif(
        not os.getenv("C_TEST_DATABASE_URL", "").startswith("postgresql"),
        reason="requires disposable PostgreSQL with A4 inbox migrations",
    ),
]


def test_home_notifications_and_action_items_use_the_signed_in_recipient(http, db, scope):
    from app.modules.a.inbox import close_action_item, create_action_item, notify

    client = http.client
    for router in (daily_router, inbox_router):
        client.app.include_router(router, prefix="/api/v1")
    client.headers["Origin"] = "http://localhost:3000"
    me, peer = scope.users["author"], scope.users["outsider"]
    task = {"kind": "task", "id": scope.task.id, "project_id": scope.project.id}
    peer_task = {"kind": "task", "id": scope.other_task.id, "project_id": scope.other_project.id}
    db.add(CourseMember(id=uuid4(), course_id=scope.course.id, user_id=me.id))
    db.add(TaskAssignee(task_id=scope.task.id, user_id=me.id, role="responsible"))
    notify(db, recipient=me, category="system", title="Welcome")
    assigned = notify(db, recipient=me, category="project", title="Assigned", target=task)
    private = notify(db, recipient=peer, category="project", title="Private", target=peer_task)
    action = create_action_item(db, recipient=me, category="task", title="Work", target=task)
    other_action = create_action_item(
        db, recipient=peer, category="task", title="Peer", target=peer_task
    )
    db.commit()
    http.sign_in(me)

    def get(path):
        response = client.get(f"/api/v1/{path}")
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "private, no-store"
        return response.json()["data"]

    notices = "me/notifications"
    actions = "me/action-items"
    home = get("home/summary")
    assert (home["unread_notifications"], home["pending_action_items"]) == (2, 1)
    assert (home["my_task_count"], home["my_completed_tasks"]) == (1, 0)
    assert [p["href"] for p in home["projects"]] == [f"/projects/{scope.project.id}"]
    assert [c["id"] for c in home["courses"]] == [str(scope.course.id)]
    first = get(f"{notices}?page_size=1")
    second = get(f"{notices}?page_size=1&page=2")
    assert first["total"] == second["unread_total"] == 2
    assert [first["items"][0]["title"], second["items"][0]["title"]] == ["Assigned", "Welcome"]
    assert first["snapshot_id"] == second["snapshot_id"]
    task_href = f"/projects/{scope.project.id}/tasks/{scope.task.id}"
    assert first["items"][0]["href"] == task_href
    work = get(f"{actions}?category=task")
    assert work["total"] == 1 and work["items"][0]["id"] == str(action.id)
    assert work["items"][0]["href"] == task_href

    def post(path, body, key):
        return client.post(f"/api/v1/{path}", json=body, headers={"Idempotency-Key": key})

    snapshot = {
        "expected_inbox_version": first["inbox_version"],
        "snapshot_id": first["snapshot_id"],
    }
    body = {**snapshot, "expected_version": first["items"][0]["lock_version"]}
    assert post(f"{notices}/{private.id}/read", body, "foreign").status_code == 404
    receipt = post(f"{notices}/{assigned.id}/read", body, "one")
    assert receipt.status_code == 200, receipt.text
    assert (
        post(f"{notices}/{assigned.id}/read", body, "one").json()["data"] == receipt.json()["data"]
    )
    assert get("home/summary")["unread_notifications"] == 1
    assert post(f"{notices}/read-all", snapshot, "stale").status_code == 409
    unread = get(f"{notices}?state=unread")
    assert unread["total"] == 1 and unread["items"][0]["title"] == "Welcome"
    remaining = {
        "expected_inbox_version": unread["inbox_version"],
        "snapshot_id": unread["snapshot_id"],
    }
    assert post(f"{notices}/read-all", remaining, "all").status_code == 200
    assert client.post(f"/api/v1/{actions}/{action.id}/complete").status_code in {404, 405}
    assert get(actions)["total"] == 1

    # The owning handling page closes the shared action; D owns task completion.
    close_action_item(db, action.id, actor=me)
    scope.task.status = "completed"
    db.commit()
    refreshed = get("home/summary")
    assert (refreshed["unread_notifications"], refreshed["pending_action_items"]) == (0, 0)
    assert refreshed["my_completed_tasks"] == 1 and get(actions)["items"] == []
    assert get(f"{actions}?status=completed")["items"][0]["id"] == str(action.id)

    http.sign_in(peer, student_id="ST0002")
    assert get("home/summary")["unread_notifications"] == 1
    assert [row["id"] for row in get(f"{notices}?state=unread")["items"]] == [str(private.id)]
    assert [row["id"] for row in get(actions)["items"]] == [str(other_action.id)]
