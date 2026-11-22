"""Persisted MaterialTextPort adapter bridging B3-04 materials to A4-05 text extraction."""

from __future__ import annotations

import re
from uuid import UUID

from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.a import permissions, storage, text_extraction
from app.modules.b.ports import MaterialText, MaterialTextPort, TextSegment

_PARAGRAPH_SPLIT = re.compile(r"\n{2,}")


def split_material_segments(text: str) -> tuple[TextSegment, ...]:
    cleaned = text.strip()
    if not cleaned:
        return ()
    chunks = [chunk.strip() for chunk in _PARAGRAPH_SPLIT.split(cleaned) if chunk.strip()]
    return tuple(
        TextSegment(segment_id=f"seg-{index}", text=chunk)
        for index, chunk in enumerate(chunks, start=1)
    )


class PersistedMaterialTextPort(MaterialTextPort):
    """Reads verified upload receipts via A4-05 (``app.modules.a.text_extraction``)."""

    def __init__(self, *, client: storage.StorageClient | None = None) -> None:
        self._client = client

    def get_text(self, session: Session, *, receipt_id: UUID, actor_id: UUID) -> MaterialText:
        if session is None:
            return MaterialText(
                receipt_id=receipt_id,
                status="unavailable",
                reason="正文提取服务需要数据库连接。",
            )
        actor = session.get(User, actor_id)
        if actor is None or not permissions.is_active(actor):
            raise ApiError(404, "NOT_FOUND", "上传记录不存在。")

        try:
            extracted = text_extraction.read_receipt_text(
                session,
                actor,
                receipt_id,
                client=self._client,
            )
        except ApiError as err:
            if err.status_code in {403, 404}:
                raise ApiError(404, "NOT_FOUND", "上传记录不存在。") from err
            if err.status_code == 503:
                return MaterialText(
                    receipt_id=receipt_id,
                    status="unavailable",
                    reason=err.message,
                )
            return MaterialText(
                receipt_id=receipt_id,
                status="failed",
                reason=err.message,
            )

        segments = split_material_segments(extracted.text)
        if not segments:
            return MaterialText(
                receipt_id=receipt_id,
                status="failed",
                reason="未检测到可提取的文字内容（可能为空白文件或扫描版 PDF），请粘贴文本资料。",
            )

        reason = "文件正文较长，已按上限截断。" if extracted.truncated else None
        return MaterialText(
            receipt_id=receipt_id,
            status="ready",
            segments=segments,
            reason=reason,
        )
