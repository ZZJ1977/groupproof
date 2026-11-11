"""A6 飞书只读同步：绑定项目群、拉取群消息快照、为 C 的活动页提供可信来源。

边界（V1）：
- 只使用企业自建应用的只读权限：读取群消息。代码里没有任何发消息、改群的调用；
- 凭证只来自后端变量 ``FEISHU_APP_ID`` / ``FEISHU_APP_SECRET``，不进入数据库、日志或前端；
- 只能同步已绑定到项目的群，且只能由项目负责人绑定和触发同步；
- 同步失败（网络、权限、分页超上限）整体抛 503，不会把失败解释成“消息被删除”；
- 写操作只 ``flush``，由调用方的事务提交。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from uuid import UUID, uuid4

import httpx
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import User
from app.modules.a import permissions
from app.modules.a.audit import record_audit
from app.modules.a.models import FeishuChatLink, FeishuMessage
from app.modules.c.activity_ports import (
    ActivitySourcePage,
    ActivitySourceQuery,
    ActivitySourceRecord,
)
from app.modules.c.source_ports import VerifiedSource

FEISHU_API_BASE = "https://open.feishu.cn"
PAGE_SIZE = 50  # 飞书消息列表单页上限
MAX_PAGES_PER_CHAT = 200  # 单次同步最多 10000 条；超过就失败，不做部分提交
TOKEN_REFRESH_MARGIN = 300  # 访问令牌到期前 5 分钟重新获取
MAX_TEXT_CHARS = 2000
_CHAT_ID = re.compile(r"oc_[A-Za-z0-9_-]{4,120}")
_UNAVAILABLE = "FEISHU_UNAVAILABLE"


def _unavailable(message: str = "飞书暂时不可用，请稍后重试。") -> ApiError:
    return ApiError(503, _UNAVAILABLE, message)


# ------------------------------------------------------------------ 配置与客户端


@dataclass(frozen=True)
class FeishuSettings:
    app_id: str
    app_secret: str
    base_url: str = FEISHU_API_BASE


def feishu_settings() -> FeishuSettings | None:
    app_id = os.environ.get("FEISHU_APP_ID", "").strip()
    app_secret = os.environ.get("FEISHU_APP_SECRET", "").strip()
    if not app_id or not app_secret:
        return None  # 未接入：接口返回 503，不假装同步成功
    return FeishuSettings(app_id=app_id, app_secret=app_secret)


@dataclass(frozen=True)
class FeishuMessageItem:
    message_id: str
    msg_type: str
    create_time_ms: int
    sender_open_id: str | None
    sender_type: str
    deleted: bool
    content: str


@dataclass(frozen=True)
class FeishuChatItem:
    chat_id: str
    name: str


class FeishuReader(Protocol):
    def list_chat_messages(
        self, chat_id: str, page_token: str | None
    ) -> tuple[list[FeishuMessageItem], str | None]: ...

    def list_bot_chats(self, page_token: str | None) -> tuple[list[FeishuChatItem], str | None]: ...


class FeishuClient:
    """只读客户端：获取租户访问令牌、按群列出消息。"""

    def __init__(
        self,
        settings: FeishuSettings,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if not settings.base_url.startswith("https://"):
            raise ValueError("Feishu base URL must use https")
        self._settings = settings
        self._http = httpx.Client(base_url=settings.base_url, timeout=15.0, transport=transport)
        self._token: str | None = None
        self._token_expires_at: datetime | None = None

    def close(self) -> None:
        self._http.close()

    def _access_token(self) -> str:
        now = datetime.now(UTC)
        if (
            self._token
            and self._token_expires_at
            and now < self._token_expires_at - timedelta(seconds=TOKEN_REFRESH_MARGIN)
        ):
            return self._token
        try:
            response = self._http.post(
                "/open-apis/auth/v3/tenant_access_token/internal",
                json={"app_id": self._settings.app_id, "app_secret": self._settings.app_secret},
            )
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise _unavailable() from exc
        token = body.get("tenant_access_token")
        if response.status_code != 200 or body.get("code") != 0 or not token:
            raise _unavailable("飞书应用凭证无效或未生效，请检查 Railway 变量。")
        self._token = token
        self._token_expires_at = now + timedelta(seconds=int(body.get("expire", 0)))
        return token

    def list_chat_messages(
        self, chat_id: str, page_token: str | None
    ) -> tuple[list[FeishuMessageItem], str | None]:
        params: dict[str, Any] = {
            "container_id_type": "chat",
            "container_id": chat_id,
            "sort_type": "ByCreateTimeAsc",
            "page_size": PAGE_SIZE,
        }
        if page_token:
            params["page_token"] = page_token
        try:
            response = self._http.get(
                "/open-apis/im/v1/messages",
                params=params,
                headers={"Authorization": f"Bearer {self._access_token()}"},
            )
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise _unavailable() from exc
        if response.status_code != 200 or body.get("code") != 0:
            raise _unavailable("无法读取该飞书群的消息，请确认机器人已在群中且有读取权限。")
        data = body.get("data") or {}
        items = [_parse_item(raw) for raw in data.get("items") or []]
        next_token = data.get("page_token") if data.get("has_more") else None
        return items, next_token

    def list_bot_chats(self, page_token: str | None) -> tuple[list[FeishuChatItem], str | None]:
        """列出机器人所在的群（只读），用于让用户从下拉列表里选群，而不是手动输入群 ID。"""
        params: dict[str, Any] = {"page_size": PAGE_SIZE}
        if page_token:
            params["page_token"] = page_token
        try:
            response = self._http.get(
                "/open-apis/im/v1/chats",
                params=params,
                headers={"Authorization": f"Bearer {self._access_token()}"},
            )
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise _unavailable() from exc
        if response.status_code != 200 or body.get("code") != 0:
            raise _unavailable("无法获取机器人所在的群列表，请确认应用权限已发布。")
        data = body.get("data") or {}
        items = [
            FeishuChatItem(chat_id=str(raw["chat_id"]), name=str(raw.get("name") or ""))
            for raw in data.get("items") or []
            if raw.get("chat_id")
        ]
        next_token = data.get("page_token") if data.get("has_more") else None
        return items, next_token


def _parse_item(raw: dict[str, Any]) -> FeishuMessageItem:
    sender = raw.get("sender") or {}
    return FeishuMessageItem(
        message_id=str(raw["message_id"]),
        msg_type=str(raw.get("msg_type") or "unknown"),
        create_time_ms=int(raw.get("create_time") or 0),
        sender_open_id=sender.get("id") or None,
        sender_type=str(sender.get("sender_type") or "unknown"),
        deleted=bool(raw.get("deleted", False)),
        content=str((raw.get("body") or {}).get("content") or ""),
    )


def get_feishu_reader() -> FeishuReader | None:
    settings = feishu_settings()
    return FeishuClient(settings) if settings else None


def _require_reader(reader: FeishuReader | None) -> FeishuReader:
    if reader is None:
        raise _unavailable("飞书尚未接入（缺少应用凭证变量）。")
    return reader


# ------------------------------------------------------------------ 文本与指纹


def _plain_text(msg_type: str, content: str) -> str:
    if msg_type == "text":
        try:
            text = json.loads(content).get("text", "")
        except (ValueError, AttributeError):
            text = ""
        return str(text)[:MAX_TEXT_CHARS]
    return f"[{msg_type}]"


def _content_hash(msg_type: str, text: str, deleted: bool) -> str:
    payload = json.dumps(
        {"msg_type": msg_type, "text": text, "deleted": deleted},
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ 绑定与同步


def link_chat(session: Session, actor: User, project_id: UUID, chat_id: str) -> FeishuChatLink:
    """项目负责人绑定一个飞书群。重复绑定同一个群是幂等的。"""
    permissions.require_project_leader(session, actor, project_id, write=True)
    if not _CHAT_ID.fullmatch(chat_id or ""):
        raise ApiError(422, "INVALID_FEISHU_CHAT", "飞书群 ID 格式不正确。")
    existing = session.scalar(
        select(FeishuChatLink).where(
            FeishuChatLink.project_id == project_id, FeishuChatLink.chat_id == chat_id
        )
    )
    if existing is not None:
        return existing
    link = FeishuChatLink(id=uuid4(), project_id=project_id, chat_id=chat_id, linked_by_id=actor.id)
    session.add(link)
    session.flush()
    record_audit(
        session,
        actor=actor,
        action="feishu.chat.linked",
        target=("feishu_chat_link", link.id),
        project_id=project_id,
        after={"chat_id": chat_id},
    )
    return link


def list_available_chats(
    session: Session, actor: User, project_id: UUID, reader: FeishuReader | None
) -> list[FeishuChatItem]:
    """项目负责人查看机器人所在的群，供绑定时选择。最多返回 200 个群，防止无限分页。"""
    permissions.require_project_leader(session, actor, project_id, write=False)
    client = _require_reader(reader)
    chats: list[FeishuChatItem] = []
    token: str | None = None
    for _ in range(MAX_PAGES_PER_CHAT):
        items, token = client.list_bot_chats(token)
        chats.extend(items)
        if not token or len(chats) >= 200:
            break
    return chats[:200]


def sync_project(
    session: Session, actor: User, project_id: UUID, reader: FeishuReader | None
) -> dict[str, int]:
    """拉取项目绑定的所有群的消息快照。任何一步失败都会抛错，调用方应回滚。"""
    permissions.require_project_leader(session, actor, project_id, write=True)
    client = _require_reader(reader)
    links = session.scalars(
        select(FeishuChatLink).where(FeishuChatLink.project_id == project_id)
    ).all()
    totals = {"chats": len(links), "created": 0, "updated": 0, "deleted": 0, "seen": 0}
    now = datetime.now(UTC)
    for link in links:
        for item in _iter_chat(client, link.chat_id):
            totals["seen"] += 1
            _upsert(session, project_id, link.chat_id, item, now, totals)
    session.flush()
    record_audit(
        session,
        actor=actor,
        action="feishu.sync.completed",
        target=("project", project_id),
        project_id=project_id,
        after=totals,
    )
    return totals


def _iter_chat(client: FeishuReader, chat_id: str):
    token: str | None = None
    for _ in range(MAX_PAGES_PER_CHAT):
        items, token = client.list_chat_messages(chat_id, token)
        yield from items
        if not token:
            return
    # 超过上限不做部分提交：宁可失败，也不把没读到的消息当成“不存在”。
    raise _unavailable("群消息超过单次同步上限，请联系管理员分段同步。")


def _upsert(
    session: Session,
    project_id: UUID,
    chat_id: str,
    item: FeishuMessageItem,
    now: datetime,
    totals: dict[str, int],
) -> None:
    text = "" if item.deleted else _plain_text(item.msg_type, item.content)
    digest = _content_hash(item.msg_type, text, item.deleted)
    occurred_at = datetime.fromtimestamp(item.create_time_ms / 1000, UTC)
    row = session.scalar(
        select(FeishuMessage).where(
            FeishuMessage.project_id == project_id,
            FeishuMessage.message_id == item.message_id,
        )
    )
    if row is None:
        session.add(
            FeishuMessage(
                id=uuid4(),
                project_id=project_id,
                chat_id=chat_id,
                message_id=item.message_id,
                sender_open_id=item.sender_open_id,
                sender_type=item.sender_type,
                msg_type=item.msg_type,
                text=text,
                content_hash=digest,
                occurred_at=occurred_at,
                deleted=item.deleted,
                synced_at=now,
            )
        )
        totals["created"] += 1
        if item.deleted:
            totals["deleted"] += 1
        return
    if row.content_hash != digest or row.deleted != item.deleted:
        row.text = text
        row.msg_type = item.msg_type
        row.content_hash = digest
        row.deleted = item.deleted
        row.synced_at = now
        totals["updated"] += 1
        if item.deleted:
            totals["deleted"] += 1


# ------------------------------------------------------------------ C 的活动来源端口


def _sender_label(row: FeishuMessage) -> str:
    return "飞书成员" if row.sender_open_id else "未知发送者"


def _record(row: FeishuMessage) -> ActivitySourceRecord:
    title = "[已删除的消息]" if row.deleted else (row.text[:60] or f"[{row.msg_type}]")
    summary = "" if row.deleted else row.text[:200]
    return ActivitySourceRecord(
        id=row.id,
        title=title,
        summary=summary,
        author_id=None,  # 飞书 open_id 到本站用户的映射尚未建立
        author_name=_sender_label(row),
        occurred_at=row.occurred_at,
        kind="message",
        source=VerifiedSource(
            project_id=row.project_id,
            source_type="feishu",
            identity=row.message_id,
            revision=row.content_hash,
            content={
                "chat_id": row.chat_id,
                "msg_type": row.msg_type,
                "text": summary,
                "deleted": row.deleted,
            },
            source_url=None,
            source_reference_id=row.id,
            availability="deleted" if row.deleted else "available",
        ),
        group_id=row.chat_id,
    )


class DatabaseFeishuActivityPort:
    """C 活动页（ActivitySourcePort）的飞书实现：只读本地快照，权限按项目成员检查。

    GitHub 来源仍未接入，明确返回 503。
    """

    def __init__(self, session_factory) -> None:
        self._session_factory = session_factory

    def query(
        self, *, project_id: UUID, actor_id: UUID, source_type: str, query: ActivitySourceQuery
    ):
        with self._session_factory() as session:
            _check_feishu(session, project_id, actor_id, source_type)
            if query.author_id is not None:
                # 飞书发送者到本站用户的映射还没有，不能假装能按人过滤。
                raise _unavailable("按成员筛选飞书消息暂不可用。")
            if query.include_ids is not None and len(query.include_ids) == 0:
                return ActivitySourcePage(items=(), total=0)
            if query.record_kind not in (None, "message"):
                return ActivitySourcePage(items=(), total=0)

            filters = [FeishuMessage.project_id == project_id]
            if query.group_id:
                filters.append(FeishuMessage.chat_id == query.group_id)
            if query.since is not None:
                filters.append(FeishuMessage.occurred_at >= query.since)
            if query.until is not None:
                filters.append(FeishuMessage.occurred_at <= query.until)
            if query.q:
                filters.append(FeishuMessage.text.ilike(f"%{_escape_like(query.q)}%", escape="\\"))
            if query.include_ids is not None:
                filters.append(FeishuMessage.id.in_(query.include_ids))
            if query.exclude_ids:
                filters.append(FeishuMessage.id.notin_(query.exclude_ids))

            total = session.scalar(select(func.count()).select_from(FeishuMessage).where(*filters))
            offset = (query.page - 1) * query.page_size
            rows = session.scalars(
                select(FeishuMessage)
                .where(*filters)
                .order_by(FeishuMessage.occurred_at.desc(), FeishuMessage.id.asc())
                .offset(offset)
                .limit(query.page_size)
            ).all()
            return ActivitySourcePage(items=tuple(_record(r) for r in rows), total=total or 0)

    def get(self, *, project_id: UUID, actor_id: UUID, source_type: str, source_id: UUID):
        with self._session_factory() as session:
            _check_feishu(session, project_id, actor_id, source_type)
            row = session.scalar(
                select(FeishuMessage).where(
                    FeishuMessage.id == source_id, FeishuMessage.project_id == project_id
                )
            )
            if row is None:
                raise ApiError(404, "ACTIVITY_NOT_FOUND", "记录不存在。")
            return _record(row)


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _check_feishu(session: Session, project_id: UUID, actor_id: UUID, source_type: str) -> None:
    if source_type != "feishu":
        raise _unavailable("该来源尚未接入。")
    actor = session.get(User, actor_id)
    permissions.require_project_member(session, actor, project_id, write=False)


def feishu_activity_port(session_factory) -> DatabaseFeishuActivityPort:
    return DatabaseFeishuActivityPort(session_factory)


def list_linked_chats(session: Session, actor: User, project_id: UUID) -> list[FeishuChatLink]:
    """项目成员可以查看本项目绑定了哪些飞书群（不包含凭证）。"""
    permissions.require_project_member(session, actor, project_id, write=False)
    return list(
        session.scalars(
            select(FeishuChatLink)
            .where(FeishuChatLink.project_id == project_id)
            .order_by(FeishuChatLink.linked_at.asc())
        ).all()
    )
