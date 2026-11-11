"""Translate A's authorized Feishu message projection into C activity/evidence records."""

import hashlib
import json
import re
from dataclasses import replace
from datetime import UTC

from app.api.errors import ApiError
from app.modules.c.activity_ports import ActivitySourcePort, ActivitySourceRecord

_CONTACT = re.compile(
    r"[\w.%+\-]+@[\w.\-]+\.[\w-]+"
    r"|(?<!\d)(?:(?:\+?86[ -]?)?1[3-9]\d[ -]?\d{4}[ -]?\d{4}"
    r"|(?:\+?853[ -]?)?6\d{3}[ -]?\d{4}|\+[1-9]\d{7,14})(?!\d)",
    re.ASCII,
)


def _message(record: ActivitySourceRecord) -> ActivitySourceRecord:
    source = record.source
    payload = source.content
    text, kind, deleted = payload.get("text"), payload.get("msg_type"), payload.get("deleted")
    if not isinstance(text, str) or not isinstance(kind, str) or not isinstance(deleted, bool):
        raise ApiError(
            503, "ACTIVITY_SOURCE_INVALID", "The Feishu message projection is incomplete."
        )
    # A hashes these three fields before shortening text for its activity feed.
    # Equality distinguishes a complete 200-character message from a longer excerpt.
    encoded = json.dumps(
        {"msg_type": kind, "text": text, "deleted": deleted}, ensure_ascii=False, sort_keys=True
    )
    complete = (
        kind == "text"
        and bool(text.strip())
        and hashlib.sha256(encoded.encode()).hexdigest() == source.revision
    )
    display = _CONTACT.sub("[已脱敏]", text)
    if not complete and not deleted:
        # An excerpt may end part-way through a number or address.
        display = re.sub(r"\+?\d[\d ()-]{3,}$|[\w.%+\-]+@[\w.\-]*$", "…", display, flags=re.ASCII)
    content = {**payload, "text": display}
    if not complete and not deleted:
        content["preview_only"] = True
    return replace(
        record,
        title="[已删除的消息]" if deleted else (display.strip()[:60] or f"[{kind}]"),
        summary=display,
        # A stores UTC; SQLite returns its timestamps without a timezone.
        occurred_at=record.occurred_at
        if record.occurred_at.tzinfo
        else record.occurred_at.replace(tzinfo=UTC),
        source=replace(
            source,
            content=content,
            # A's row ID identifies its message, not a shared SourceReference.
            source_reference_id=None
            if source.source_reference_id == record.id
            else source.source_reference_id,
        ),
    )


class FeishuActivityPort:
    def __init__(self, upstream: ActivitySourcePort):
        self.upstream = upstream

    def get(self, *, project_id, actor_id, source_type, source_id):
        record = self.upstream.get(
            project_id=project_id, actor_id=actor_id, source_type=source_type, source_id=source_id
        )
        return _message(record) if source_type == "feishu" else record

    def query(self, *, project_id, actor_id, source_type, query):
        if source_type == "feishu" and query.q and ("@" in query.q or _CONTACT.search(query.q)):
            raise ApiError(
                422, "INVALID_ACTIVITY_QUERY", "请使用消息内容或群组筛选，联系方式已脱敏。"
            )
        page = self.upstream.query(
            project_id=project_id, actor_id=actor_id, source_type=source_type, query=query
        )
        if source_type != "feishu":
            return page
        # A filters the full authorized DB text before LIMIT/OFFSET. A match may
        # be outside the preview or in a contact removed from the display text.
        return replace(
            page, items=tuple(_message(row) for row in page.items), searched_full_text=True
        )
