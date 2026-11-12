"""Translate A's authorized Feishu message projection into C activity/evidence records."""

import hashlib
import json
import re
from dataclasses import replace
from datetime import UTC

from pydantic import ValidationError

from app.api.errors import ApiError
from app.modules.a.redaction import redact_text
from app.modules.c.activity_ports import ActivitySourcePort, ActivitySourceRecord
from app.modules.c.activity_schemas import FeishuAttachmentSnapshot

_CONTACT = re.compile(
    r"[\w.%+\-]+@[\w.\-]+\.[\w-]+"
    r"|(?<!\d)(?:(?:\+?86[ -]?)?1[3-9]\d[ -]?\d{4}[ -]?\d{4}"
    r"|(?:\+?853[ -]?)?6\d{3}[ -]?\d{4}|\+[1-9]\d{7,14})(?!\d)",
    re.ASCII,
)


def _redact(text: str) -> str:
    # Older synchronized rows and attachment names predate A's text redaction.
    return _CONTACT.sub("[已脱敏]", redact_text(text))


def _digest(fields: dict) -> str:
    encoded = json.dumps(fields, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(encoded.encode()).hexdigest()


def _message(record: ActivitySourceRecord) -> ActivitySourceRecord:
    source = record.source
    payload = source.content
    text, kind, deleted = payload.get("text"), payload.get("msg_type"), payload.get("deleted")
    if not isinstance(text, str) or not isinstance(kind, str) or not isinstance(deleted, bool):
        raise ApiError(
            503, "ACTIVITY_SOURCE_INVALID", "The Feishu message projection is incomplete."
        )
    detail = "version_no" in payload
    attachments = []
    keys = []
    raw_attachments = payload.get("attachments", [])
    if not isinstance(raw_attachments, list):
        raise ApiError(503, "ACTIVITY_SOURCE_INVALID", "Invalid Feishu attachment list.")
    for raw in raw_attachments:
        if not isinstance(raw, dict) or not isinstance(raw.get("available"), bool):
            raise ApiError(503, "ACTIVITY_SOURCE_INVALID", "Invalid Feishu attachment.")
        if not raw["available"]:
            continue  # Upstream retains attachments removed in later message versions.
        if not isinstance(raw.get("file_key"), str) or not raw["file_key"]:
            raise ApiError(503, "ACTIVITY_SOURCE_INVALID", "Missing Feishu attachment reference.")
        try:
            attachment = FeishuAttachmentSnapshot.model_validate(raw)
        except ValidationError as exc:
            raise ApiError(503, "ACTIVITY_SOURCE_INVALID", "Invalid Feishu attachment.") from exc
        if attachment.name:
            attachment.name = _redact(attachment.name)
        attachment.verified = (
            attachment.verified
            and attachment.sha256 is not None
            and attachment.size_bytes is not None
        )
        attachments.append(attachment.model_dump(mode="json"))
        keys.append(raw["file_key"])

    fields = {"msg_type": kind, "text": text, "deleted": deleted}

    # Legacy rows used a three-field digest and a 2,000-character storage cap.
    # A's current revision also covers the keys of the current version's attachments.
    legacy = kind == "text" and not keys and _digest(fields) == source.revision
    matches = (
        len(text) < 30000 and _digest({**fields, "attachments": sorted(keys)}) == source.revision
    ) or (legacy and len(text) < 2000)
    has_content = (kind in {"text", "post"} and bool(text.strip())) or bool(attachments)
    complete = matches and has_content and all(a["verified"] for a in attachments)
    display = redact_text(_CONTACT.sub("[已脱敏]", text)) if legacy else _redact(text)
    if not detail and not complete and not deleted:
        # An excerpt may end part-way through a number or address.
        display = re.sub(r"\+?\d[\d ()-]{3,}$|[\w.%+\-]+@[\w.\-]*$", "…", display, flags=re.ASCII)
    content = {
        "chat_id": payload.get("chat_id"),
        "msg_type": kind,
        "deleted": deleted,
        "text": display,
    }
    if detail and not legacy:
        content.update(version_no=payload["version_no"], attachments=attachments)
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
