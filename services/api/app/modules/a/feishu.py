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
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from urllib.parse import unquote
from uuid import UUID, uuid4

import httpx
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.models import ProjectMember, User
from app.modules.a import permissions
from app.modules.a.audit import record_audit
from app.modules.a.models import (
    FeishuAttachment,
    FeishuChatLink,
    FeishuMessage,
    FeishuMessageVersion,
)
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
MAX_TEXT_CHARS = 30000  # 与 C 的来源快照上限一致（脱敏后全文）
_CHAT_ID = re.compile(r"oc_[A-Za-z0-9_-]{4,120}")
_UNAVAILABLE = "FEISHU_UNAVAILABLE"
_FEISHU_DOC_URL_RE = re.compile(
    r"https://[A-Za-z0-9.-]*\.(?:feishu\.cn|larksuite\.com)/(docx|docs|wiki|sheets|file)/([A-Za-z0-9_-]{6,120})",
    re.IGNORECASE,
)
_FEISHU_SCOPE_LIST_RE = re.compile(r"\[([a-z0-9_:,.\s-]+)\]", re.IGNORECASE)
_FEISHU_AUTH_URL_RE = re.compile(r"https://open\.(?:feishu\.cn|larksuite\.com)/app/[^\s\"'，。]+")


class FeishuScopeDeniedError(ApiError):
    """飞书应用尚未开通对应只读权限（code=99991672）。"""

    def __init__(
        self,
        message: str,
        *,
        missing_scopes: list[str] | None = None,
        auth_url: str | None = None,
    ) -> None:
        self.missing_scopes = list(missing_scopes or [])
        self.auth_url = auth_url
        super().__init__(
            503,
            _UNAVAILABLE,
            message,
            details={"missing_scopes": self.missing_scopes, "auth_url": auth_url},
        )


def _unavailable(message: str = "飞书暂时不可用，请稍后重试。") -> ApiError:
    return ApiError(503, _UNAVAILABLE, message)


def _raise_feishu_error(body: dict[str, Any], fallback: str) -> None:
    code = body.get("code")
    msg = str(body.get("msg") or "")
    if code == 99991672:
        scopes: list[str] = []
        m = _FEISHU_SCOPE_LIST_RE.search(msg)
        if m:
            scopes = [part.strip() for part in m.group(1).split(",") if part.strip()]
        auth_match = _FEISHU_AUTH_URL_RE.search(msg)
        auth_url = auth_match.group(0) if auth_match else None
        scope_label = " / ".join(scopes) if scopes else "群消息与文档只读权限"
        raise FeishuScopeDeniedError(
            f"飞书应用尚未开通所需只读权限（{scope_label}），请在飞书开放平台开通并发布应用版本后重试。",
            missing_scopes=scopes,
            auth_url=auth_url,
        )
    raise _unavailable(fallback)


def extract_feishu_doc_links(text: str) -> list[tuple[str, str, str]]:
    """从消息正文中提取去重后的飞书云文档 / 知识库 / 文件链接 (kind, token, url)。"""
    seen: set[tuple[str, str]] = set()
    found: list[tuple[str, str, str]] = []
    for match in _FEISHU_DOC_URL_RE.finditer(text or ""):
        kind = match.group(1).lower()
        token = match.group(2)
        if (kind, token) in seen:
            continue
        seen.add((kind, token))
        found.append((kind, token, match.group(0)))
    return found


_DOCX_CODE_LANGS: dict[int, str] = {
    1: "text",
    7: "bash",
    8: "csharp",
    9: "cpp",
    10: "c",
    12: "css",
    18: "dockerfile",
    22: "go",
    24: "html",
    28: "json",
    29: "java",
    30: "javascript",
    32: "kotlin",
    39: "markdown",
    49: "python",
    52: "ruby",
    53: "rust",
    56: "sql",
    60: "sh",
    61: "swift",
    63: "typescript",
    66: "xml",
    67: "yaml",
    72: "graphql",
}

_DOCX_HEADING_KEYS: dict[int, tuple[int, str]] = {
    3: (1, "heading1"),
    4: (2, "heading2"),
    5: (3, "heading3"),
    6: (4, "heading4"),
    7: (5, "heading5"),
    8: (6, "heading6"),
    9: (6, "heading7"),
    10: (6, "heading8"),
    11: (6, "heading9"),
}


def _wrap_inline_style(text: str, prefix: str, suffix: str | None = None) -> str:
    """Wrap non-whitespace core of text with markdown markers, keeping outer spaces outside."""
    end = suffix if suffix is not None else prefix
    stripped = text.strip()
    if not stripped:
        return text
    lead = len(text) - len(text.lstrip())
    trail = len(text) - len(text.rstrip())
    return f"{text[:lead]}{prefix}{stripped}{end}{text[len(text) - trail :] if trail else ''}"


def _render_docx_elements(elements: list[dict[str, Any]] | None, *, plain: bool = False) -> str:
    """将飞书 Docx 的 inline elements 渲染为 GFM 行内 Markdown（plain=True 时返回原始文本）。"""
    parts: list[str] = []
    for elem in elements or []:
        if not isinstance(elem, dict):
            continue
        if "text_run" in elem and isinstance(elem["text_run"], dict):
            run = elem["text_run"]
            content = str(run.get("content") or "")
            if not content:
                continue
            if plain:
                parts.append(content)
                continue
            style = run.get("text_element_style") or {}
            text = content
            if style.get("inline_code"):
                ticks = "``" if "`" in text else "`"
                padded = f" {text} " if text.startswith("`") or text.endswith("`") else text
                text = f"{ticks}{padded}{ticks}"
            else:
                if style.get("bold"):
                    text = _wrap_inline_style(text, "**")
                if style.get("italic"):
                    text = _wrap_inline_style(text, "*")
                if style.get("strikethrough"):
                    text = _wrap_inline_style(text, "~~")
            link = style.get("link")
            if isinstance(link, dict) and link.get("url"):
                raw_url = unquote(str(link["url"]).strip())
                if raw_url.startswith(("http://", "https://")):
                    core = text.strip()
                    if core:
                        lead = len(text) - len(text.lstrip())
                        trail = len(text) - len(text.rstrip())
                        tail = text[len(text) - trail :] if trail else ""
                        text = f"{text[:lead]}[{core}]({raw_url}){tail}"
            parts.append(text)
        elif "mention_doc" in elem and isinstance(elem["mention_doc"], dict):
            mdoc = elem["mention_doc"]
            title = str(mdoc.get("title") or mdoc.get("token") or "飞书文档").strip()
            url = unquote(str(mdoc.get("url") or "").strip())
            if not plain and url.startswith(("http://", "https://")):
                parts.append(f"[{title}]({url})")
            else:
                parts.append(title)
        elif "mention_user" in elem and isinstance(elem["mention_user"], dict):
            muser = elem["mention_user"]
            name = str(muser.get("name") or "").strip()
            parts.append(f"@{name}" if name else "@成员")
        elif "equation" in elem and isinstance(elem["equation"], dict):
            expr = str(elem["equation"].get("content") or "").strip()
            if expr:
                parts.append(expr if plain else f"`{expr}`")
        elif "file" in elem and isinstance(elem["file"], dict):
            fname = str(elem["file"].get("name") or "").strip()
            if fname:
                parts.append(fname)
    return "".join(parts)


def _docx_block_elements(block: dict[str, Any]) -> list[dict[str, Any]]:
    bt = block.get("block_type")
    if bt in _DOCX_HEADING_KEYS:
        key = _DOCX_HEADING_KEYS[bt][1]
        return list((block.get(key) or {}).get("elements") or [])
    for key in ("text", "bullet", "ordered", "code", "quote", "todo"):
        if key in block and isinstance(block[key], dict):
            return list(block[key].get("elements") or [])
    return []


def _escape_table_cell(value: str) -> str:
    return value.replace("\\", "\\\\").replace("|", "\\|").replace("\r\n", "\n").replace("\n", " ")


def docx_blocks_to_markdown(
    blocks: list[dict[str, Any]],
    *,
    image_renderer: Callable[[dict[str, Any]], str | None] | None = None,
) -> str:
    """将飞书 Docx Block 树转换为标准 GFM Markdown（保留标题、列表、表格、代码、引用与图片）。"""
    if not blocks:
        return ""
    by_id: dict[str, dict[str, Any]] = {}
    for block in blocks:
        bid = block.get("block_id")
        if isinstance(bid, str) and bid:
            by_id[bid] = block

    visited: set[str] = set()

    def _cell_text(cell_id: str) -> str:
        cell = by_id.get(cell_id)
        if not cell or cell_id in visited:
            return ""
        visited.add(cell_id)
        fragments: list[str] = []
        for child_id in cell.get("children") or []:
            child = by_id.get(child_id)
            if not child or child_id in visited:
                continue
            visited.add(child_id)
            cbt = child.get("block_type")
            if cbt == 27:
                rendered = image_renderer(child) if image_renderer else None
                if rendered:
                    fragments.append(rendered.strip())
                continue
            text = _render_docx_elements(_docx_block_elements(child)).strip()
            if cbt == 12 and text:
                fragments.append(f"• {text}")
            elif cbt == 17 and text:
                done = bool(((child.get("todo") or {}).get("style") or {}).get("done"))
                fragments.append(f"{'☑' if done else '☐'} {text}")
            elif text:
                fragments.append(text)
            for grand_id in child.get("children") or []:
                grand = by_id.get(grand_id)
                if grand and grand_id not in visited:
                    visited.add(grand_id)
                    gtext = _render_docx_elements(_docx_block_elements(grand)).strip()
                    if gtext:
                        fragments.append(gtext)
        joined = "；".join(frag for frag in fragments if frag)
        return _escape_table_cell(joined)

    def _render_table(block: dict[str, Any]) -> str:
        table = block.get("table") or {}
        prop = table.get("property") or {}
        cell_ids = list(table.get("cells") or block.get("children") or [])
        col_size = int(prop.get("column_size") or 0)
        row_size = int(prop.get("row_size") or 0)
        if col_size <= 0:
            if not cell_ids:
                return ""
            col_size = len(cell_ids)
        if row_size <= 0:
            row_size = (len(cell_ids) + col_size - 1) // col_size
        grid: list[list[str]] = []
        for r in range(row_size):
            row_cells: list[str] = []
            for c in range(col_size):
                idx = r * col_size + c
                row_cells.append(_cell_text(cell_ids[idx]) if idx < len(cell_ids) else "")
            grid.append(row_cells)
        if not grid:
            return ""
        header = "| " + " | ".join(grid[0]) + " |"
        sep = "| " + " | ".join("---" for _ in range(col_size)) + " |"
        body = ["| " + " | ".join(row) + " |" for row in grid[1:]]
        return "\n".join([header, sep, *body])

    def _render_children(child_ids: list[str], *, indent: int = 0) -> list[str]:
        out: list[str] = []
        ordered_counter = 0
        prev_was_list = False
        for cid in child_ids:
            block = by_id.get(cid)
            if not block or cid in visited:
                continue
            visited.add(cid)
            bt = block.get("block_type")
            prefix = "  " * indent
            is_list = bt in (12, 13, 17)
            if bt != 13:
                ordered_counter = 0

            if bt in _DOCX_HEADING_KEYS:
                level, _ = _DOCX_HEADING_KEYS[bt]
                text = _render_docx_elements(_docx_block_elements(block)).strip()
                if text:
                    if out and prev_was_list:
                        out.append("")
                    out.append(f"{'#' * level} {text}")
                    out.append("")
                nested = _render_children(list(block.get("children") or []), indent=indent)
                if nested:
                    out.extend(nested)
                    out.append("")
                prev_was_list = False
            elif bt == 2:
                text = _render_docx_elements(_docx_block_elements(block)).rstrip()
                if text.strip():
                    if out and prev_was_list:
                        out.append("")
                    out.append(f"{prefix}{text}")
                    out.append("")
                nested = _render_children(list(block.get("children") or []), indent=indent)
                if nested:
                    out.extend(nested)
                    out.append("")
                prev_was_list = False
            elif bt == 12:
                text = _render_docx_elements(_docx_block_elements(block)).strip()
                out.append(f"{prefix}- {text}")
                nested = _render_children(list(block.get("children") or []), indent=indent + 1)
                if nested:
                    out.extend(nested)
                prev_was_list = True
            elif bt == 13:
                ordered_counter += 1
                text = _render_docx_elements(_docx_block_elements(block)).strip()
                out.append(f"{prefix}{ordered_counter}. {text}")
                nested = _render_children(list(block.get("children") or []), indent=indent + 1)
                if nested:
                    out.extend(nested)
                prev_was_list = True
            elif bt == 17:
                done = bool(((block.get("todo") or {}).get("style") or {}).get("done"))
                text = _render_docx_elements(_docx_block_elements(block)).strip()
                out.append(f"{prefix}- [{'x' if done else ' '}] {text}")
                nested = _render_children(list(block.get("children") or []), indent=indent + 1)
                if nested:
                    out.extend(nested)
                prev_was_list = True
            elif bt == 14:
                code_obj = block.get("code") or {}
                lang_id = (code_obj.get("style") or {}).get("language")
                lang = _DOCX_CODE_LANGS.get(int(lang_id), "") if isinstance(lang_id, int) else ""
                code_text = _render_docx_elements(
                    list(code_obj.get("elements") or []), plain=True
                ).rstrip("\n")
                fence_str = "````" if "```" in code_text else "```"
                if out and prev_was_list:
                    out.append("")
                out.append(f"{prefix}{fence_str}{lang}")
                for line in code_text.splitlines() or [""]:
                    out.append(f"{prefix}{line}")
                out.append(f"{prefix}{fence_str}")
                out.append("")
                prev_was_list = False
            elif bt == 15:
                text = _render_docx_elements(_docx_block_elements(block)).strip()
                if out and prev_was_list:
                    out.append("")
                if text:
                    for line in text.splitlines():
                        out.append(f"{prefix}> {line}")
                nested = _render_children(list(block.get("children") or []), indent=0)
                for line in nested:
                    out.append(f"{prefix}> {line}" if line else f"{prefix}>")
                out.append("")
                prev_was_list = False
            elif bt in (19, 34):
                nested = _render_children(list(block.get("children") or []), indent=0)
                if nested:
                    if out and prev_was_list:
                        out.append("")
                    # Trim leading/trailing blank lines inside quote/callout
                    while nested and not nested[0].strip():
                        nested.pop(0)
                    while nested and not nested[-1].strip():
                        nested.pop()
                    for line in nested:
                        out.append(f"{prefix}> {line}" if line else f"{prefix}>")
                    out.append("")
                prev_was_list = False
            elif bt == 22:
                if out and prev_was_list:
                    out.append("")
                out.append(f"{prefix}---")
                out.append("")
                prev_was_list = False
            elif bt == 27:
                if out and prev_was_list:
                    out.append("")
                rendered_img = image_renderer(block) if image_renderer else None
                if rendered_img:
                    out.append(f"{prefix}{rendered_img}")
                    out.append("")
                else:
                    token = str((block.get("image") or {}).get("token") or "").strip()
                    if token:
                        out.append(f"{prefix}> 🖼 **文档图片**（`{token}`）")
                        out.append("")
                prev_was_list = False
            elif bt == 31:
                if out and prev_was_list:
                    out.append("")
                table_md = _render_table(block)
                if table_md:
                    for line in table_md.splitlines():
                        out.append(f"{prefix}{line}")
                    out.append("")
                prev_was_list = False
            elif bt == 32:
                # Orphan table cell outside table
                nested = _render_children(list(block.get("children") or []), indent=indent)
                if nested:
                    out.extend(nested)
            else:
                # Container blocks (grid=24, grid_column=25, source_synced=49, etc.)
                text = _render_docx_elements(_docx_block_elements(block)).strip()
                if text:
                    if out and prev_was_list:
                        out.append("")
                    out.append(f"{prefix}{text}")
                    out.append("")
                nested = _render_children(list(block.get("children") or []), indent=indent)
                if nested:
                    if out and prev_was_list and not text:
                        out.append("")
                    out.extend(nested)
                    out.append("")
                prev_was_list = is_list
        return out

    root = next((b for b in blocks if b.get("block_type") == 1), None)
    if root is not None:
        if isinstance(root.get("block_id"), str):
            visited.add(root["block_id"])
        lines = _render_children(list(root.get("children") or []))
    else:
        top_ids = [
            str(b["block_id"])
            for b in blocks
            if isinstance(b.get("block_id"), str) and b.get("parent_id") not in by_id
        ]
        lines = _render_children(top_ids)

    # Collapse consecutive blank lines to at most one
    cleaned: list[str] = []
    for line in lines:
        if not line.strip():
            if cleaned and cleaned[-1] != "":
                cleaned.append("")
        else:
            cleaned.append(line.rstrip())
    return "\n".join(cleaned).strip()


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

    def download_resource(self, message_id: str, file_key: str, resource_type: str) -> bytes: ...


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
            _raise_feishu_error(
                body if isinstance(body, dict) else {},
                "无法读取该飞书群的消息，请确认机器人已在群中且有读取权限。",
            )
        data = body.get("data") or {}
        items = [_parse_item(raw) for raw in data.get("items") or []]
        next_token = data.get("page_token") if data.get("has_more") else None
        return items, next_token

    def download_resource(self, message_id: str, file_key: str, resource_type: str) -> bytes:
        """下载消息里的附件内容（只读），超过 20MB 或读取失败都报 503，不返回部分内容。"""
        try:
            with self._http.stream(
                "GET",
                f"/open-apis/im/v1/messages/{message_id}/resources/{file_key}",
                params={"type": resource_type},
                headers={"Authorization": f"Bearer {self._access_token()}"},
            ) as response:
                if response.status_code != 200:
                    try:
                        err_body = json.loads(response.read().decode("utf-8", errors="ignore"))
                    except ValueError:
                        err_body = {}
                    _raise_feishu_error(
                        err_body if isinstance(err_body, dict) else {},
                        "无法读取这个附件，可能已被删除或机器人没有权限。",
                    )
                data = bytearray()
                for chunk in response.iter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_VERIFY_BYTES:
                        raise _unavailable("附件超过 20MB，暂不支持核验。")
        except httpx.HTTPError as exc:
            raise _unavailable() from exc
        return bytes(data)

    def list_chat_tabs(self, chat_id: str) -> list[dict[str, Any]]:
        """列出飞书群标签页（只读），用于发现群内固定的云文档与链接。"""
        try:
            response = self._http.get(
                f"/open-apis/im/v1/chats/{chat_id}/chat_tabs/list_tabs",
                headers={"Authorization": f"Bearer {self._access_token()}"},
            )
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise _unavailable() from exc
        if response.status_code != 200 or body.get("code") != 0:
            _raise_feishu_error(
                body if isinstance(body, dict) else {},
                "无法读取该飞书群的标签页。",
            )
        return list((body.get("data") or {}).get("chat_tabs") or [])

    def get_docx_document(self, doc_token: str) -> tuple[str, str]:
        """读取飞书云文档标题与 Markdown 正文（只读，结构化块优先，空时回退 raw_content）。"""
        title, blocks = self.get_docx_document_with_blocks(doc_token)
        if blocks:
            rendered = docx_blocks_to_markdown(blocks)
            if rendered.strip():
                return title, rendered
        headers = {"Authorization": f"Bearer {self._access_token()}"}
        try:
            raw_resp = self._http.get(
                f"/open-apis/docx/v1/documents/{doc_token}/raw_content",
                headers=headers,
            )
            raw_body = raw_resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise _unavailable() from exc
        if raw_resp.status_code != 200 or raw_body.get("code") != 0:
            _raise_feishu_error(
                raw_body if isinstance(raw_body, dict) else {},
                "无法读取该飞书云文档正文。",
            )
        content = str((raw_body.get("data") or {}).get("content") or "")
        return title, content

    def get_docx_document_with_blocks(self, doc_token: str) -> tuple[str, list[dict[str, Any]]]:
        """读取飞书云文档（docx）标题与完整结构化块列表（自动分页，只读）。"""
        headers = {"Authorization": f"Bearer {self._access_token()}"}
        try:
            meta_resp = self._http.get(
                f"/open-apis/docx/v1/documents/{doc_token}",
                headers=headers,
            )
            meta_body = meta_resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise _unavailable() from exc
        if meta_resp.status_code != 200 or meta_body.get("code") != 0:
            _raise_feishu_error(
                meta_body if isinstance(meta_body, dict) else {},
                "无法读取该飞书云文档元信息。",
            )
        title = str(
            ((meta_body.get("data") or {}).get("document") or {}).get("title") or ""
        ).strip()
        blocks = self.list_docx_blocks(doc_token)
        return title or doc_token, blocks

    def list_docx_blocks(self, doc_token: str) -> list[dict[str, Any]]:
        """分页拉取飞书云文档所有 Block（只读，最多 40 页 / 20000 块）。"""
        headers = {"Authorization": f"Bearer {self._access_token()}"}
        items: list[dict[str, Any]] = []
        page_token: str | None = None
        for _ in range(40):
            params: dict[str, Any] = {"page_size": 500}
            if page_token:
                params["page_token"] = page_token
            try:
                resp = self._http.get(
                    f"/open-apis/docx/v1/documents/{doc_token}/blocks",
                    params=params,
                    headers=headers,
                )
                body = resp.json()
            except (httpx.HTTPError, ValueError) as exc:
                raise _unavailable() from exc
            if resp.status_code != 200 or body.get("code") != 0:
                _raise_feishu_error(
                    body if isinstance(body, dict) else {},
                    "无法读取该飞书云文档结构化内容。",
                )
            data = body.get("data") or {}
            page_items = data.get("items") or []
            for block in page_items:
                if isinstance(block, dict):
                    items.append(block)
            if not data.get("has_more"):
                break
            next_token = data.get("page_token")
            if not next_token or next_token == page_token:
                break
            page_token = str(next_token)
        return items

    def download_drive_media(self, file_token: str) -> tuple[bytes, str]:
        """下载飞书云文档内嵌图片/素材（只读，不超过 20MB）。"""
        try:
            with self._http.stream(
                "GET",
                f"/open-apis/drive/v1/medias/{file_token}/download",
                headers={"Authorization": f"Bearer {self._access_token()}"},
            ) as response:
                if response.status_code != 200:
                    try:
                        err_body = json.loads(response.read().decode("utf-8", errors="ignore"))
                    except ValueError:
                        err_body = {}
                    _raise_feishu_error(
                        err_body if isinstance(err_body, dict) else {},
                        "无法读取飞书文档内嵌图片，可能缺少云盘只读权限。",
                    )
                content_type = (
                    response.headers.get("content-type", "application/octet-stream")
                    .split(";", 1)[0]
                    .strip()
                    .lower()
                )
                data = bytearray()
                for chunk in response.iter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_VERIFY_BYTES:
                        raise _unavailable("飞书图片超过 20MB，暂不支持预览。")
        except httpx.HTTPError as exc:
            raise _unavailable() from exc
        return bytes(data), content_type

    def get_wiki_node_obj(self, node_token: str) -> tuple[str, str, str] | None:
        """解析知识库节点，返回 (obj_type, obj_token, title)。"""
        try:
            resp = self._http.get(
                "/open-apis/wiki/v2/spaces/get_node",
                params={"token": node_token},
                headers={"Authorization": f"Bearer {self._access_token()}"},
            )
            body = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise _unavailable() from exc
        if resp.status_code != 200 or body.get("code") != 0:
            _raise_feishu_error(
                body if isinstance(body, dict) else {},
                "无法读取该飞书知识库节点。",
            )
        node = (body.get("data") or {}).get("node") or {}
        obj_type = str(node.get("obj_type") or "").lower()
        obj_token = str(node.get("obj_token") or "")
        title = str(node.get("title") or "")
        return (obj_type, obj_token, title) if obj_type and obj_token else None

    def list_bot_chats(self, page_token: str | None) -> tuple[list[FeishuChatItem], str | None]:
        """列出机器人所在的群（只读），用于校验用户提交的群聊 ID。"""
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


ATTACHMENT_KINDS = {"image": "image", "file": "file", "audio": "audio", "media": "media"}


@dataclass(frozen=True)
class ParsedMessage:
    text: str  # 已脱敏的全文
    attachments: tuple[dict[str, Any], ...]  # [{"file_key", "kind", "name"}]


def _json(content: str) -> dict[str, Any]:
    try:
        value = json.loads(content)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _post_text(body: dict[str, Any]) -> tuple[list[str], list[dict[str, Any]]]:
    """富文本：按语言取第一份内容，拼出文字，并收集里面的图片/视频。"""
    if "content" not in body:
        body = next((v for v in body.values() if isinstance(v, dict) and "content" in v), {})
    lines: list[str] = []
    attachments: list[dict[str, Any]] = []
    title = body.get("title")
    if isinstance(title, str) and title.strip():
        lines.append(title.strip())
    for paragraph in body.get("content") or []:
        parts: list[str] = []
        for node in paragraph if isinstance(paragraph, list) else []:
            if not isinstance(node, dict):
                continue
            tag = node.get("tag")
            if tag == "text":
                parts.append(str(node.get("text") or ""))
            elif tag == "a":
                label = str(node.get("text") or "")
                href = str(node.get("href") or "")
                if href and _FEISHU_DOC_URL_RE.search(href) and href not in label:
                    parts.append(f"{label} ({href})" if label else href)
                else:
                    parts.append(label)
            elif tag == "at":
                parts.append("@" + str(node.get("user_name") or "成员"))
            elif tag == "img" and node.get("image_key"):
                attachments.append({"file_key": str(node["image_key"]), "kind": "image"})
            elif tag == "media" and node.get("file_key"):
                attachments.append({"file_key": str(node["file_key"]), "kind": "media"})
        lines.append("".join(parts))
    return lines, attachments


def parse_message(msg_type: str, content: str) -> ParsedMessage:
    """把飞书消息体变成脱敏的全文和附件引用。不认识的类型只留类型占位。"""
    from app.modules.a.redaction import redact_text

    body = _json(content)
    attachments: list[dict[str, Any]] = []
    if msg_type == "text":
        text = str(body.get("text", ""))
    elif msg_type == "post":
        lines, attachments = _post_text(body)
        text = "\n".join(lines).strip()
    elif msg_type in ATTACHMENT_KINDS:
        key = body.get("file_key") or body.get("image_key")
        if key:
            attachment = {"file_key": str(key), "kind": ATTACHMENT_KINDS[msg_type]}
            if body.get("file_name"):
                attachment["name"] = str(body["file_name"])[:300]
            attachments.append(attachment)
        text = f"[{msg_type}]" + (f" {body['file_name']}" if body.get("file_name") else "")
    elif msg_type == "interactive":
        urls = [url for _, _, url in extract_feishu_doc_links(content)]
        title_obj = body.get("title")
        card_title = title_obj if isinstance(title_obj, str) else ""
        text_parts = [p for p in ("[interactive]", card_title, *urls) if p]
        text = " ".join(text_parts)
    else:
        urls = [url for _, _, url in extract_feishu_doc_links(content)]
        text = f"[{msg_type}]" + (" " + " ".join(urls) if urls else "")
    unique: dict[str, dict[str, Any]] = {}
    for item in attachments:
        unique.setdefault(item["file_key"], item)
    return ParsedMessage(
        text=redact_text(text)[:MAX_TEXT_CHARS], attachments=tuple(unique.values())
    )


def _content_hash(msg_type: str, text: str, deleted: bool, attachments=()) -> str:
    payload = json.dumps(
        {
            "msg_type": msg_type,
            "text": text,
            "deleted": deleted,
            "attachments": sorted(a["file_key"] for a in attachments),
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ 绑定与同步


def link_chat(
    session: Session, actor: User, project_id: UUID, chat_id: str, reader: FeishuReader | None
) -> FeishuChatLink:
    """项目负责人绑定机器人可读取的群。重复绑定同一个群是幂等的。"""
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
    if all(chat.chat_id != chat_id for chat in _list_bot_chats(reader)):
        raise ApiError(
            422,
            "FEISHU_CHAT_NOT_AVAILABLE",
            "机器人当前无法访问此群，请确认机器人已加入并检查群聊 ID。",
        )
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
    """项目负责人查看机器人所在的群，供诊断与兼容旧客户端。最多返回 200 个群。"""
    permissions.require_project_leader(session, actor, project_id, write=False)
    return _list_bot_chats(reader)


def _list_bot_chats(reader: FeishuReader | None) -> list[FeishuChatItem]:
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
    parsed = ParsedMessage("", ()) if item.deleted else parse_message(item.msg_type, item.content)
    text, attachments = parsed.text, parsed.attachments
    digest = _content_hash(item.msg_type, text, item.deleted, attachments)
    occurred_at = datetime.fromtimestamp(item.create_time_ms / 1000, UTC)
    row = session.scalar(
        select(FeishuMessage).where(
            FeishuMessage.project_id == project_id,
            FeishuMessage.message_id == item.message_id,
        )
    )
    if row is None:
        row = FeishuMessage(
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
            version_no=1,
            synced_at=now,
        )
        session.add(row)
        session.flush()
        _record_version(session, row, attachments)
        _sync_attachments(session, row, attachments)
        totals["created"] += 1
        if item.deleted:
            totals["deleted"] += 1
        return
    if row.content_hash != digest or row.deleted != item.deleted:
        row.text = text
        row.msg_type = item.msg_type
        row.content_hash = digest
        row.deleted = item.deleted
        row.version_no += 1
        row.synced_at = now
        _record_version(session, row, attachments)
        _sync_attachments(session, row, attachments)
        totals["updated"] += 1
        if item.deleted:
            totals["deleted"] += 1


def _record_version(session: Session, row: FeishuMessage, attachments) -> None:
    session.add(
        FeishuMessageVersion(
            id=uuid4(),
            message_row_id=row.id,
            version_no=row.version_no,
            content_hash=row.content_hash,
            text=row.text,
            attachments=[dict(a) for a in attachments],
            deleted=row.deleted,
        )
    )


def _sync_attachments(session: Session, row: FeishuMessage, attachments) -> None:
    """按最新版本的附件列表对齐；消失的附件标记不可用（保留行和已核验的指纹）。"""
    existing = {
        a.file_key: a
        for a in session.scalars(
            select(FeishuAttachment).where(FeishuAttachment.message_row_id == row.id)
        )
    }
    keep = set()
    for item in attachments:
        keep.add(item["file_key"])
        found = existing.get(item["file_key"])
        if found is None:
            session.add(
                FeishuAttachment(
                    id=uuid4(),
                    message_row_id=row.id,
                    file_key=item["file_key"],
                    kind=item["kind"],
                    name=item.get("name"),
                    available=True,
                )
            )
        else:
            found.available = True
    for key, found in existing.items():
        if key not in keep:
            found.available = False


# ------------------------------------------------------------------ C 的活动来源端口


def _load_feishu_member_map(session: Session, project_id: UUID) -> dict[str, tuple[UUID, str]]:
    """一次查询加载本项目已绑定飞书账号的成员映射：{feishu_account: (user.id, user.name)}。"""
    rows = session.execute(
        select(User.feishu_account, User.id, User.name)
        .join(ProjectMember, ProjectMember.user_id == User.id)
        .where(
            ProjectMember.project_id == project_id,
            ProjectMember.left_at.is_(None),
            User.feishu_account.is_not(None),
        )
        .order_by(ProjectMember.joined_at.asc(), User.id.asc())
    ).all()
    mapping: dict[str, tuple[UUID, str]] = {}
    for feishu_account, user_id, name in rows:
        key = (feishu_account or "").strip()
        if not key or key in mapping:
            continue
        mapping[key] = (user_id, (name or "").strip())
    return mapping


def _sender_label(row: FeishuMessage) -> str:
    return "飞书成员" if (row.sender_open_id or "").strip() else "未知发送者"


def _resolve_sender(
    row: FeishuMessage, member_map: dict[str, tuple[UUID, str]] | None = None
) -> tuple[UUID | None, str]:
    key = (row.sender_open_id or "").strip()
    if row.sender_type != "app" and key and member_map and key in member_map:
        user_id, name = member_map[key]
        return user_id, name or "飞书成员"
    return None, _sender_label(row)


def _attachment_view(a: FeishuAttachment) -> dict[str, Any]:
    return {
        "id": str(a.id),
        "file_key": a.file_key,
        "kind": a.kind,
        "name": a.name,
        "size_bytes": a.size_bytes,
        "sha256": a.content_sha256,
        "verified": a.verified_at is not None,
        "available": a.available,
    }


def _record(
    row: FeishuMessage,
    attachments: list[FeishuAttachment] | None = None,
    *,
    full: bool = False,
    member_map: dict[str, tuple[UUID, str]] | None = None,
) -> ActivitySourceRecord:
    """列表只给前 200 字（短）；``get`` 给脱敏后的全文、版本号和附件引用（full=True）。"""
    first_line = (row.text.strip().splitlines() or [""])[0]
    title = "[已删除的消息]" if row.deleted else (first_line[:60] or f"[{row.msg_type}]")
    summary = "" if row.deleted else (row.text if full else row.text[:200])
    author_id, author_name = _resolve_sender(row, member_map)
    content: dict[str, Any] = {
        "chat_id": row.chat_id,
        "msg_type": row.msg_type,
        "text": summary,
        "deleted": row.deleted,
    }
    if full:
        content["version_no"] = row.version_no
        content["attachments"] = [_attachment_view(a) for a in attachments or []]
    return ActivitySourceRecord(
        id=row.id,
        title=title,
        summary=summary,
        author_id=author_id,
        author_name=author_name,
        occurred_at=row.occurred_at,
        kind="message",
        source=VerifiedSource(
            project_id=row.project_id,
            source_type="feishu",
            identity=row.message_id,
            revision=row.content_hash,
            content=content,
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
            if query.include_ids is not None and len(query.include_ids) == 0:
                return ActivitySourcePage(items=(), total=0)
            if query.record_kind not in (None, "message"):
                return ActivitySourcePage(items=(), total=0)

            member_map = _load_feishu_member_map(session, project_id)
            filters = [FeishuMessage.project_id == project_id]
            if query.author_id is not None:
                matched_open_ids = [
                    open_id
                    for open_id, (user_id, _) in member_map.items()
                    if user_id == query.author_id
                ]
                if not matched_open_ids:
                    return ActivitySourcePage(items=(), total=0)
                filters.append(FeishuMessage.sender_type != "app")
                filters.append(func.trim(FeishuMessage.sender_open_id).in_(matched_open_ids))
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
            return ActivitySourcePage(
                items=tuple(_record(r, member_map=member_map) for r in rows), total=total or 0
            )

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
            attachments = list(
                session.scalars(
                    select(FeishuAttachment)
                    .where(FeishuAttachment.message_row_id == row.id)
                    .order_by(FeishuAttachment.file_key)
                )
            )
            member_map = _load_feishu_member_map(session, project_id)
            return _record(row, attachments, full=True, member_map=member_map)


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
    """项目成员及本课教师/助教可只读查看本项目绑定了哪些飞书群（不包含凭证或消息正文）。"""
    permissions.require_project_read(session, actor, project_id)
    return list(
        session.scalars(
            select(FeishuChatLink)
            .where(FeishuChatLink.project_id == project_id)
            .order_by(FeishuChatLink.linked_at.asc())
        ).all()
    )


# ------------------------------------------------------------------ 消息详情与附件核验

MAX_VERIFY_BYTES = 20 * 1024 * 1024
_RESOURCE_TYPE = {"image": "image", "file": "file", "audio": "file", "media": "file"}


@dataclass(frozen=True)
class MessageDetail:
    message: FeishuMessage
    versions: list[FeishuMessageVersion]
    attachments: list[FeishuAttachment]


def get_message_detail(
    session: Session, actor: User, project_id: UUID, message_row_id: UUID
) -> MessageDetail:
    """项目成员查看一条消息的脱敏全文、所有版本和附件引用。"""
    permissions.require_project_member(session, actor, project_id, write=False)
    row = session.scalar(
        select(FeishuMessage).where(
            FeishuMessage.id == message_row_id, FeishuMessage.project_id == project_id
        )
    )
    if row is None:
        raise ApiError(404, "ACTIVITY_NOT_FOUND", "记录不存在。")
    versions = list(
        session.scalars(
            select(FeishuMessageVersion)
            .where(FeishuMessageVersion.message_row_id == row.id)
            .order_by(FeishuMessageVersion.version_no)
        )
    )
    attachments = list(
        session.scalars(
            select(FeishuAttachment)
            .where(FeishuAttachment.message_row_id == row.id)
            .order_by(FeishuAttachment.file_key)
        )
    )
    return MessageDetail(row, versions, attachments)


def verify_attachment(
    session: Session,
    actor: User,
    project_id: UUID,
    attachment_id: UUID,
    reader: FeishuReader | None,
) -> FeishuAttachment:
    """用机器人凭证下载附件并记录 SHA-256 和大小；内容不入库，下载失败整体 503。"""
    relation = permissions.require_project_member(session, actor, project_id, write=False)
    if not relation.member:
        raise ApiError(403, "PROJECT_MEMBER_REQUIRED", "只有本项目成员可以核验附件。")
    attachment = session.scalar(
        select(FeishuAttachment)
        .join(FeishuMessage, FeishuMessage.id == FeishuAttachment.message_row_id)
        .where(FeishuAttachment.id == attachment_id, FeishuMessage.project_id == project_id)
    )
    if attachment is None:
        raise ApiError(404, "ATTACHMENT_NOT_FOUND", "附件不存在。")
    if attachment.verified_at is not None:
        return attachment  # 指纹一旦记录就不改写；要换版本需要新消息版本
    message = session.get(FeishuMessage, attachment.message_row_id)
    client = _require_reader(reader)
    data = client.download_resource(
        message.message_id, attachment.file_key, _RESOURCE_TYPE[attachment.kind]
    )
    attachment.content_sha256 = hashlib.sha256(data).hexdigest()
    attachment.size_bytes = len(data)
    attachment.verified_at = datetime.now(UTC)
    session.flush()
    record_audit(
        session,
        actor=actor,
        action="feishu.attachment.verified",
        target=("feishu_attachment", attachment.id),
        project_id=project_id,
        after={"sha256": attachment.content_sha256, "size_bytes": attachment.size_bytes},
    )
    return attachment
