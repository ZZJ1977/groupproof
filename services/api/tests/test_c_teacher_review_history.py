"""C7 review history reads A's saved facts through actual Cookie/Admin guards."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
import test_c_auth_verification_integration as fixtures

from app.auth.models import TeacherApplication
from app.auth.services.registration import review_basis

db, scope, http = fixtures.db, fixtures.scope, fixtures.http
ENDPOINT = "/api/v1/c-admin/teacher-applications"


def application(db, scope, status="pending", *, identifier=None, snapshot=None):
    row = TeacherApplication(
        id=identifier or uuid4().hex,
        user_id=scope.users["teacher"].id,
        application_version=7,
        snapshot=snapshot
        if snapshot is not None
        else {
            "name": "Submitted teacher name",
            "requestedIdentity": "teacher",
            "schoolEmailNormalized": "private-address@original.example.edu",
            "unrelatedSecret": "must-not-be-projected",
        },
        status=status,
        reviewer_id=scope.users["admin"].id if status != "pending" else None,
        reviewed_at=datetime(2026, 10, 15, tzinfo=UTC) if status != "pending" else None,
        reason="<script>ordinary saved text</script>\nExplain the decision"
        if status != "pending"
        else None,
        created_at=datetime(2026, 10, 14, tzinfo=UTC),
    )
    db.add(row)
    db.flush()
    return row


def read(http, **query):
    response = http.client.get(ENDPOINT, params=query)
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "private, no-store"
    return response.json()["data"]


def test_status_filters_count_before_fixed_pagination_and_use_stable_order(http, db, scope):
    http.sign_in(scope.users["admin"])
    before = {
        status: read(http, status=status)["total"]
        for status in ("pending", "approved", "rejected", "all")
    }
    pending = application(db, scope)
    approved = application(db, scope, "approved")
    rejected = [application(db, scope, "rejected") for _ in range(13)]
    db.commit()
    default = read(http)
    assert default["total"] == before["pending"] + 1
    assert all(row["status"] == "pending" for row in default["items"])
    assert read(http, status="approved")["total"] == before["approved"] + 1
    rejected_page = read(http, status="rejected", page=1)
    assert rejected_page["total"] == before["rejected"] + 13
    assert rejected_page["pageSize"] == 10 and len(rejected_page["items"]) == 10
    pages = [
        read(http, status="rejected", page=page)
        for page in range(1, (rejected_page["total"] + 9) // 10 + 1)
    ]
    ids = {row.id for row in rejected}
    actual = [row["id"] for page in pages for row in page["items"] if row["id"] in ids]
    assert actual == sorted(ids) and len(actual) == len(set(actual))
    assert all(row["status"] == "rejected" for page in pages for row in page["items"])
    assert read(http, status="all")["total"] == before["all"] + 15
    assert pending.status == "pending" and approved.status == "approved"
    assert read(http, status="rejected", page=1_000_000)["items"] == []


@pytest.mark.parametrize("status", ["approved", "rejected"])
def test_saved_basis_and_decision_are_not_inferred_from_current_account(http, db, scope, status):
    http.sign_in(scope.users["admin"])
    row = application(db, scope, status)
    teacher = scope.users["teacher"]
    teacher.name = "Changed current name"
    teacher.global_role = "student"
    teacher.status = "disabled"
    teacher.email_binding.school_email = "current-private@current.example.edu"
    teacher.email_binding.school_email_normalized = "current-private@current.example.edu"
    teacher.email_binding.verified_at = None
    scope.users["admin"].name = "Current reviewer name"
    db.commit()
    data = read(http, status=status)
    result = next(item for item in data["items"] if item["id"] == row.id)
    assert result["status"] == status and result["applicationVersion"] == 7
    assert result["submittedName"] == "Submitted teacher name"
    assert result["submittedIdentity"] == "teacher"
    assert result["submittedEmailDomain"] == "original.example.edu"
    assert result["name"] == "Changed current name"
    assert result["emailDomain"] == "current.example.edu" and not result["emailVerified"]
    assert result["reviewerName"] == "Current reviewer name"
    assert result["reviewedAt"].startswith("2026-10-15")
    assert result["reviewReason"] == row.reason
    assert set(result) == {
        "id",
        "userId",
        "name",
        "college",
        "applicationVersion",
        "status",
        "createdAt",
        "emailVerified",
        "emailDomain",
        "submittedName",
        "submittedIdentity",
        "submittedEmailDomain",
        "reviewedAt",
        "reviewerName",
        "reviewReason",
    }
    assert "private@" not in str(result) and "private-address@" not in str(result)
    assert "must-not-be-projected" not in str(result)


def test_missing_historical_fields_stay_unknown_instead_of_copying_current_data(http, db, scope):
    http.sign_in(scope.users["admin"])
    row = application(db, scope, "approved", snapshot={})
    row.reviewer_id = None
    row.reviewed_at = None
    row.reason = None
    db.commit()
    result = next(item for item in read(http, status="approved")["items"] if item["id"] == row.id)
    assert (
        result["submittedName"]
        is result["submittedIdentity"]
        is result["submittedEmailDomain"]
        is None
    )
    assert result["reviewerName"] is result["reviewedAt"] is result["reviewReason"] is None
    assert result["name"]  # The current value exists but does not fill historical fields.


def test_actual_review_moves_pending_to_readable_history_and_cannot_be_decided_again(
    http, db, scope
):
    http.sign_in(scope.users["admin"])
    teacher = scope.users["teacher"]
    row = application(db, scope, snapshot=review_basis(teacher, teacher.email_binding))
    db.commit()
    command = {"decision": "reject", "reason": "Confirmed saved rejection", "expectedVersion": 7}
    response = http.client.post(f"{ENDPOINT}/{row.id}/review", json=command)
    assert response.status_code == 200, response.text
    assert all(item["id"] != row.id for item in read(http)["items"])
    result = next(item for item in read(http, status="rejected")["items"] if item["id"] == row.id)
    assert result["reviewReason"] == command["reason"] and result["reviewedAt"]
    assert http.client.post(f"{ENDPOINT}/{row.id}/review", json=command).status_code == 409


@pytest.mark.parametrize(
    "query", [{"status": "unknown"}, {"page": 0}, {"page": 1_000_001}, {"page": "1.5"}]
)
def test_history_query_validation(http, scope, query):
    http.sign_in(scope.users["admin"])
    assert http.client.get(ENDPOINT, params=query).status_code == 422


def test_history_requires_current_admin_session(http, scope):
    assert http.client.get(ENDPOINT + "?status=all").status_code == 401
    http.sign_in(scope.users["author"])
    assert http.client.get(ENDPOINT + "?status=approved").status_code == 403
    http.sign_in(scope.users["admin"])
    assert http.client.get(ENDPOINT + "?status=rejected").status_code == 200
    scope.users["admin"].global_role = "student"
    assert http.client.get(ENDPOINT + "?status=all").status_code == 403
