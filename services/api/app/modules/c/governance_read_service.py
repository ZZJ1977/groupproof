from collections import defaultdict
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal

from pydantic import ValidationError

from app.api.errors import ApiError
from app.modules.c.governance_common import current_actor
from app.modules.c.governance_read_ports import AuditPage, UsagePage
from app.modules.c.governance_read_schemas import (
    AuditFilters,
    AuditRecord,
    UsageFilters,
    UsageSample,
)


def validate_record(model, row):
    try:
        # Re-validate even model instances: a buggy adapter may have used construct.
        return model.model_validate(row.model_dump() if isinstance(row, model) else row)
    except (ValidationError, TypeError, ValueError) as error:
        raise ApiError(
            503, "GOVERNANCE_SOURCE_INVALID", "A returned invalid or unredacted metadata."
        ) from error


def audit_list(session, user, filters: AuditFilters, port):
    actor = current_actor(session, user, admin=True)
    page = port.audit_page(actor_id=actor.id, filters=filters.model_copy(deep=True))
    if (
        not isinstance(page, AuditPage)
        or type(page.total) is not int
        or page.total < 0
        or not isinstance(page.items, tuple)
    ):
        raise ApiError(503, "AUDIT_PAGE_INVALID", "A audit page is incomplete.")
    rows = [validate_record(AuditRecord, item) for item in page.items]
    if len(rows) != min(
        filters.page_size, max(0, page.total - (filters.page - 1) * filters.page_size)
    ) or len({r.id for r in rows}) != len(rows):
        raise ApiError(503, "AUDIT_PAGE_INVALID", "A audit page is incomplete or repeated.")
    if rows != sorted(rows, key=lambda row: (-row.occurred_at.timestamp(), str(row.id))):
        raise ApiError(503, "AUDIT_PAGE_INVALID", "A audit order is unstable.")
    for row in rows:
        if (
            (filters.actor_id and row.actor_id != filters.actor_id)
            or (filters.actor_role and row.actor_role != filters.actor_role)
            or (filters.target_type and row.target_type != filters.target_type)
            or (filters.target_id and row.target_id != filters.target_id)
            or (filters.action and row.action != filters.action)
            or (filters.result and row.result != filters.result)
            or (filters.since and row.occurred_at < filters.since)
            or (filters.until and row.occurred_at > filters.until)
        ):
            raise ApiError(503, "AUDIT_PAGE_INVALID", "A audit source did not apply filters.")
    return {
        "items": rows,
        "total": page.total,
        "page": filters.page,
        "page_size": filters.page_size,
    }


def audit_detail(session, user, record_id, port):
    actor = current_actor(session, user, admin=True)
    row = validate_record(AuditRecord, port.audit_detail(actor_id=actor.id, record_id=record_id))
    if row.id != record_id:
        raise ApiError(503, "AUDIT_SOURCE_INVALID", "A returned a different audit record.")
    return row


def totals(rows):
    costs = {}
    for row in rows:
        costs[row.currency] = costs.get(row.currency, Decimal(0)) + row.cost
    return {
        "requests": len(rows),
        "succeeded": sum(row.success for row in rows),
        "failed": sum(not row.success for row in rows),
        "input_tokens": sum(row.input_tokens for row in rows),
        "output_tokens": sum(row.output_tokens for row in rows),
        "cost_by_currency": {key: format(value, "f") for key, value in sorted(costs.items())},
    }


def usage_summary(session, user, filters: UsageFilters, port, *, now=None):
    actor = current_actor(session, user, admin=True)
    until = now or datetime.now(UTC)
    if until.utcoffset() is None:
        raise ValueError("The clock must return an aware timestamp")
    until = until.astimezone(UTC)
    since = datetime.combine(until.date() - timedelta(days=filters.days - 1), time.min, UTC)
    rows, seen, snapshot_id, total = [], set(), None, None
    page_number, size = 1, 200
    while True:
        page = port.usage_page(
            actor_id=actor.id,
            filters=filters.model_copy(deep=True),
            since=since,
            until=until,
            page=page_number,
            page_size=size,
            snapshot_id=snapshot_id,
        )
        if (
            not isinstance(page, UsagePage)
            or type(page.total) is not int
            or page.total < 0
            or not isinstance(page.items, tuple)
            or not isinstance(page.snapshot_id, str)
            or not page.snapshot_id.strip()
            or len(page.snapshot_id) > 200
        ):
            raise ApiError(503, "USAGE_PAGE_INVALID", "A usage snapshot is incomplete.")
        if page.total > 10000:
            raise ApiError(
                503,
                "USAGE_WINDOW_TOO_LARGE",
                "Narrow usage filters or provide an A aggregate adapter.",
            )
        if snapshot_id is None:
            snapshot_id, total = page.snapshot_id, page.total
        if (
            page.snapshot_id != snapshot_id
            or page.total != total
            or len(page.items) != min(size, max(0, total - (page_number - 1) * size))
        ):
            raise ApiError(503, "USAGE_PAGE_INVALID", "A usage snapshot changed or omitted rows.")
        for item in page.items:
            row = validate_record(UsageSample, item)
            if (
                row.id in seen
                or not since <= row.occurred_at < until
                or (filters.user_id and row.user_id != filters.user_id)
                or (filters.feature and row.feature != filters.feature)
                or (filters.model and row.model != filters.model)
            ):
                raise ApiError(
                    503,
                    "USAGE_PAGE_INVALID",
                    "A usage source returned repeated or out-of-scope rows.",
                )
            rows.append(row)
            seen.add(row.id)
        if len(rows) == total:
            break
        page_number += 1
    grouped = {field: defaultdict(list) for field in ("date", "feature", "model")}
    for row in rows:
        grouped["date"][row.occurred_at.astimezone(UTC).date()].append(row)
        grouped["feature"][row.feature].append(row)
        grouped["model"][row.model].append(row)
    daily = []
    for offset in range(filters.days):
        day = since.date() + timedelta(days=offset)
        daily.append(
            {
                "date": day,
                **totals(grouped["date"][day]),
            }
        )

    def breakdown(field):
        return [{"key": value, **totals(items)} for value, items in sorted(grouped[field].items())]

    return {
        **totals(rows),
        "days": filters.days,
        "since": since,
        "until": until,
        "source_snapshot_id": snapshot_id,
        "daily": daily,
        "by_feature": breakdown("feature"),
        "by_model": breakdown("model"),
        "aggregation_scope": "Actual A samples in inclusive UTC calendar days through the "
        "exclusive current timestamp; no estimated health, trends or missing costs.",
    }
