from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
import test_c_governance as governance_tests

from app.api.errors import ApiError
from app.modules.c.governance_read_ports import AuditPage, UnavailableGovernanceReadPort, UsagePage
from app.modules.c.governance_read_schemas import (
    AuditFilters,
    AuditRecord,
    UsageFilters,
    UsageSample,
    UsageSummaryDTO,
)
from app.modules.c.governance_read_service import audit_detail, audit_list, usage_summary

db = governance_tests.db
scope = governance_tests.scope
NOW = datetime(2026, 10, 12, 12, tzinfo=UTC)


class ReadFixture:
    def __init__(self, usage=(), audit=()):
        self.usage, self.audit, self.calls = list(usage), list(audit), []

    def usage_page(self, **query):
        self.calls.append(query)
        filters = query["filters"]
        rows = [
            r
            for r in self.usage
            if query["since"] <= r.occurred_at < query["until"]
            and (filters.user_id is None or r.user_id == filters.user_id)
            and (filters.feature is None or r.feature == filters.feature)
            and (filters.model is None or r.model == filters.model)
        ]
        offset = (query["page"] - 1) * query["page_size"]
        return UsagePage(
            tuple(rows[offset : offset + query["page_size"]]), len(rows), "stable-snapshot"
        )

    def audit_page(self, *, actor_id, filters):
        self.calls.append(filters)
        rows = [
            r
            for r in self.audit
            if (filters.actor_id is None or r.actor_id == filters.actor_id)
            and (filters.actor_role is None or r.actor_role == filters.actor_role)
            and (filters.target_type is None or r.target_type == filters.target_type)
            and (filters.target_id is None or r.target_id == filters.target_id)
            and (filters.action is None or r.action == filters.action)
            and (filters.result is None or r.result == filters.result)
            and (filters.since is None or r.occurred_at >= filters.since)
            and (filters.until is None or r.occurred_at <= filters.until)
        ]
        rows.sort(key=lambda r: (-r.occurred_at.timestamp(), str(r.id)))
        offset = (filters.page - 1) * filters.page_size
        return AuditPage(tuple(rows[offset : offset + filters.page_size]), len(rows))

    def audit_detail(self, *, actor_id, record_id):
        return next(r for r in self.audit if r.id == record_id)


def usage(scope, **changes):
    fields = dict(
        id=uuid4(),
        user_id=scope.users["author"].id,
        occurred_at=NOW - timedelta(hours=1),
        feature="verification",
        model="model-a",
        success=True,
        input_tokens=10,
        output_tokens=5,
        cost=Decimal("0.003"),
        currency="USD",
    )
    fields.update(changes)
    return UsageSample(**fields)


def audit(scope, **changes):
    fields = dict(
        id=uuid4(),
        actor_id=scope.users["admin"].id,
        actor_role="admin",
        occurred_at=NOW,
        action="course.publish",
        target_type="course",
        target_id=scope.course.id,
        result="success",
        reason="Course ready",
        before={"status": "draft"},
        after={"status": "active"},
    )
    fields.update(changes)
    return AuditRecord(**fields)


@pytest.mark.parametrize("days", [7, 30, 90])
def test_usage_aggregates_only_exact_real_window_and_keeps_currencies_separate(db, scope, days):
    start = datetime(2026, 10, 12, tzinfo=UTC) - timedelta(days=days - 1)
    records = [
        usage(scope, occurred_at=start),
        usage(
            scope,
            success=False,
            feature="report",
            model="model-b",
            cost=Decimal("0.02"),
            currency="CNY",
        ),
        usage(scope, occurred_at=start - timedelta(microseconds=1)),
        usage(scope, occurred_at=NOW),
    ]
    result = usage_summary(
        db, scope.users["admin"], UsageFilters(days=days), ReadFixture(records), now=NOW
    )
    assert result["requests"] == 2 and result["succeeded"] == result["failed"] == 1
    assert result["input_tokens"] == 20 and result["output_tokens"] == 10
    assert result["cost_by_currency"] == {"CNY": "0.02", "USD": "0.003"}
    assert len(result["daily"]) == days and result["daily"][0]["requests"] == 1
    assert {row["key"] for row in result["by_feature"]} == {"verification", "report"}
    UsageSummaryDTO.model_validate(result)


def test_usage_aware_offsets_use_utc_buckets_and_filters_are_combined(db, scope):
    row = usage(scope, occurred_at=datetime.fromisoformat("2026-10-12T03:00:00+08:00"))
    port = ReadFixture([row, usage(scope, model="other")])
    result = usage_summary(
        db,
        scope.users["admin"],
        UsageFilters(user_id=row.user_id, feature=row.feature, model=row.model),
        port,
        now=NOW,
    )
    assert result["requests"] == 1 and result["daily"][-2]["requests"] == 1
    assert result["daily"][-1]["requests"] == 0


def test_usage_all_pages_use_one_snapshot_and_no_estimated_values(db, scope):
    port = ReadFixture([usage(scope) for _ in range(201)])
    result = usage_summary(db, scope.users["admin"], UsageFilters(), port, now=NOW)
    assert result["requests"] == 201 and len(port.calls) == 2
    assert (
        port.calls[0]["snapshot_id"] is None and port.calls[1]["snapshot_id"] == "stable-snapshot"
    )
    assert "health" not in result and "trend" not in result


@pytest.mark.parametrize(
    "bad", ["missing", "duplicate", "snapshot", "total", "out_of_scope", "large"]
)
def test_usage_invalid_or_incomplete_pages_never_become_partial_totals(db, scope, bad):
    records = [usage(scope) for _ in range(201)]

    class Invalid(ReadFixture):
        def usage_page(self, **query):
            page = super().usage_page(**query)
            if bad == "large":
                return replace(page, total=10001)
            if query["page"] == 1:
                if bad == "missing":
                    return replace(page, items=page.items[:-1])
                if bad == "out_of_scope":
                    return replace(
                        page,
                        items=(
                            page.items[0].model_copy(update={"occurred_at": NOW}),
                            *page.items[1:],
                        ),
                    )
                return page
            if bad == "duplicate":
                return replace(page, items=(records[0],))
            if bad == "snapshot":
                return replace(page, snapshot_id="changed")
            return replace(page, total=202)

    with pytest.raises(ApiError) as error:
        usage_summary(db, scope.users["admin"], UsageFilters(), Invalid(records), now=NOW)
    assert error.value.status_code == 503


@pytest.mark.parametrize(
    "field,value",
    [
        ("cost", "NaN"),
        ("input_tokens", -1),
        ("currency", "unknown"),
        ("occurred_at", datetime(2026, 10, 12)),
        ("success", "yes"),
    ],
)
def test_usage_revalidates_constructed_adapter_samples(db, scope, field, value):
    record = usage(scope).model_copy(update={field: value})

    class Invalid(ReadFixture):
        def usage_page(self, **query):
            return UsagePage((record,), 1, "fixed")

    with pytest.raises(ApiError) as error:
        usage_summary(db, scope.users["admin"], UsageFilters(), Invalid(), now=NOW)
    assert error.value.code == "GOVERNANCE_SOURCE_INVALID"


def test_audit_exact_filters_pagination_detail_and_metadata_only(db, scope):
    records = [audit(scope, occurred_at=NOW - timedelta(minutes=i)) for i in range(4)]
    records.append(audit(scope, result="failure"))
    records.append(audit(scope, actor_role="teacher"))
    records.append(audit(scope, target_type="project", target_id=scope.project.id))
    records.append(audit(scope, target_id=uuid4()))
    port = ReadFixture(audit=records)
    result = audit_list(
        db,
        scope.users["admin"],
        AuditFilters(
            page=2,
            page_size=2,
            result="success",
            actor_id=scope.users["admin"].id,
            actor_role="admin",
            target_type="course",
            target_id=scope.course.id,
            action="course.publish",
            since=NOW - timedelta(hours=1),
        ),
        port,
    )
    assert result["total"] == 4 and len(result["items"]) == 2
    assert result["items"][0].id == records[2].id
    assert audit_detail(db, scope.users["admin"], records[0].id, port).before == {"status": "draft"}
    assert port.calls[0].actor_role == "admin" and port.calls[0].target_id == scope.course.id


@pytest.mark.parametrize(
    "filters", [{"actor_role": "teacher"}, {"target_type": "project"}, {"target_id": uuid4()}]
)
def test_audit_rejects_adapter_ignoring_role_or_target_filters(db, scope, filters):
    class Unfiltered(ReadFixture):
        def audit_page(self, **_):
            return AuditPage((audit(scope),), 1)

    with pytest.raises(ApiError) as error:
        audit_list(db, scope.users["admin"], AuditFilters(**filters), Unfiltered())
    assert error.value.code == "AUDIT_PAGE_INVALID"


@pytest.mark.parametrize(
    "payload",
    [{"password": "secret"}, {"body": "private project"}, {"status": {"token": "secret"}}],
)
def test_audit_rejects_unredacted_payloads(db, scope, payload):
    row = audit(scope).model_copy(update={"after": payload})
    with pytest.raises(ApiError) as error:
        audit_detail(db, scope.users["admin"], row.id, ReadFixture(audit=[row]))
    assert error.value.code == "GOVERNANCE_SOURCE_INVALID"


@pytest.mark.parametrize("actor", ["author", "teacher", "ta"])
def test_governance_reads_authorize_before_source_calls(db, scope, actor):
    port = ReadFixture()
    with pytest.raises(ApiError) as error:
        audit_list(db, scope.users[actor], AuditFilters(), port)
    assert error.value.status_code == 403
    with pytest.raises(ApiError):
        usage_summary(db, scope.users[actor], UsageFilters(), port)
    assert not port.calls


def test_empty_real_snapshot_is_zero_but_missing_adapter_is503(db, scope):
    result = usage_summary(db, scope.users["admin"], UsageFilters(), ReadFixture(), now=NOW)
    assert result["requests"] == 0 and result["cost_by_currency"] == {}
    with pytest.raises(ApiError) as error:
        usage_summary(db, scope.users["admin"], UsageFilters(), UnavailableGovernanceReadPort())
    assert error.value.code == "USAGE_SOURCE_UNAVAILABLE"
