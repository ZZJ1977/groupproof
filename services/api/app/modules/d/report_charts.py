# ruff: noqa: E501
"""Pure-vector SVG & 2.5x ultra-HD PNG diagram/chart renderer for D4 closing reports.

Supports hybrid AI-authored visual specs stored in `ReportSnapshot.data_snapshot["visuals"]`:
  - `custom_svg`: AI-authored bespoke pure-vector `<svg viewBox="0 0 1200 H">...</svg>`
    strictly validated and sanitized via XML + tag/attribute whitelist (no `<script>`,
    `<foreignObject>`, `on*`, `javascript:`, or external URLs), with graceful degradation
    to the corresponding vector template on validation failure.
  - 5 native pure-vector SVG templates (zero truncation, accurate CJK `<tspan>` wrapping,
    modern whitepaper Slate aesthetic, smooth Bézier connectors):
      1. `layered_architecture`: multi-layer architecture & module ownership diagram
      2. `process_flow`: horizontal or 2-row snake workflow pipeline with Bézier arrows
      3. `milestone_timeline`: chronological progress timeline with dates, status & deliverables
      4. `category_breakdown`: 1-panel or 2-panel ranked distribution horizontal bar chart
      5. `member_comparison`: multi-dimensional grouped horizontal comparison across members

Provides crisp 2.5x PNG rasterization (`~3000px` wide) via CairoSVG (using real `fonts-noto-cjk`
Regular & Bold on Linux Docker) for PDF (ReportLab), Word (python-docx), and `.png` endpoints.
"""

from __future__ import annotations

import logging
import math
import os
import re
import shutil
import subprocess
import unicodedata
from io import BytesIO
from typing import Any
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape as xml_escape

logger = logging.getLogger(__name__)

# ── Public contracts & registries ─────────────────────────────────────────────

TEMPLATE_ONLY_VISUALS: frozenset[str] = frozenset(
    {
        "layered_architecture",
        "process_flow",
        "milestone_timeline",
        "category_breakdown",
        "member_comparison",
    }
)

VISUAL_TEMPLATES: frozenset[str] = TEMPLATE_ONLY_VISUALS | {"custom_svg"}

VALID_SECTION_KEYS: tuple[str, ...] = (
    "overview",
    "workflow",
    "progress",
    "collaboration",
    "evidence",
    "contribution",
    "reflection",
)

SECTION_DEFAULT_TEMPLATE: dict[str, str] = {
    "overview": "layered_architecture",
    "workflow": "process_flow",
    "progress": "milestone_timeline",
    "collaboration": "category_breakdown",
    "evidence": "category_breakdown",
    "contribution": "member_comparison",
    "reflection": "category_breakdown",
}

CHART_KEY_RE = re.compile(r"^[a-z0-9_-]{1,48}$")

DEFAULT_CHART_SPECS: tuple[tuple[str, str, str, str], ...] = (
    ("architecture", "overview", "layered_architecture", "系统架构与模块分工总览图"),
    ("workflow", "workflow", "process_flow", "证据驱动的研发协作与验收流程图"),
    ("milestones", "progress", "milestone_timeline", "阶段里程碑推进与任务完成进度图"),
    ("evidence", "evidence", "category_breakdown", "正式证据来源分布与飞书协作结论结构图"),
    ("contribution", "contribution", "member_comparison", "团队成员多维贡献与分工对比图"),
)
ALLOWED_DEFAULT_CHART_KEYS: frozenset[str] = frozenset(k for k, _, _, _ in DEFAULT_CHART_SPECS)

_EVIDENCE_SOURCE_ZH: dict[str, str] = {
    "github": "GitHub 代码/PR/CI",
    "feishu": "飞书协作消息/文档",
    "file": "项目文件资料",
    "discussion": "项目讨论区结论",
    "manual": "人工提交证据",
}

_FEISHU_CATEGORY_ZH: dict[str, str] = {
    "division_confirm": "分工与方案确认",
    "task_progress": "任务推进与交付",
    "doc_review": "文档与规范同步",
    "decision": "关键技术与排期决策",
    "blocker": "阻塞与待跟进事项",
}

# ── Modern Consulting / Technical Whitepaper Design Tokens ────────────────────

CANVAS_WIDTH = 1200
PNG_RASTER_SCALE = 2.5
SVG_FONT_STACK = "'Noto Sans CJK SC', 'PingFang SC', 'Microsoft YaHei', sans-serif"

BG_WHITE = "#FFFFFF"
BG_SUBTLE = "#F8FAFC"
BG_TRACK = "#F1F5F9"
BORDER_LIGHT = "#E2E8F0"
BORDER_MED = "#CBD5E1"
TEXT_PRIMARY = "#0F172A"
TEXT_SECONDARY = "#334155"
TEXT_MUTED = "#475569"
TEXT_LIGHT = "#64748B"

ACCENT_TOKENS: dict[str, dict[str, str]] = {
    "sky": {"main": "#0284C7", "soft": "#E0F2FE", "border": "#BAE6FD", "text": "#0369A1"},
    "emerald": {"main": "#059669", "soft": "#D1FAE5", "border": "#A7F3D0", "text": "#047857"},
    "violet": {"main": "#7C3AED", "soft": "#EDE9FE", "border": "#DDD6FE", "text": "#6D28D9"},
    "amber": {"main": "#D97706", "soft": "#FEF3C7", "border": "#FDE68A", "text": "#B45309"},
    "rose": {"main": "#E11D48", "soft": "#FFE4E6", "border": "#FECDD3", "text": "#BE123C"},
    "indigo": {"main": "#4F46E5", "soft": "#E0E7FF", "border": "#C7D2FE", "text": "#4338CA"},
    "teal": {"main": "#0D9488", "soft": "#CCFBF1", "border": "#99F6E4", "text": "#0F766E"},
    "slate": {"main": "#475569", "soft": "#F1F5F9", "border": "#CBD5E1", "text": "#334155"},
}
ACCENT_CYCLE: tuple[str, ...] = ("sky", "emerald", "indigo", "violet", "amber", "teal", "rose")


def _accent(name: str | None, fallback_idx: int = 0) -> dict[str, str]:
    key = (name or "").strip().lower()
    if key in ACCENT_TOKENS:
        return ACCENT_TOKENS[key]
    return ACCENT_TOKENS[ACCENT_CYCLE[fallback_idx % len(ACCENT_CYCLE)]]


def _safe_num(val: Any, default: float = 0.0) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _safe_int(val: Any, default: int = 0) -> int:
    try:
        return int(round(float(val)))
    except (TypeError, ValueError):
        return default


def _esc(val: Any) -> str:
    return xml_escape(str(val or ""), {'"': "&quot;", "'": "&apos;"})


# ── Strict Custom SVG Security Sanitizer & Validator ──────────────────────────

_MAX_CUSTOM_SVG_BYTES = 140_000
_SVG_NS = "http://www.w3.org/2000/svg"
_ALLOWED_SVG_TAGS: frozenset[str] = frozenset(
    {
        "svg",
        "g",
        "defs",
        "title",
        "desc",
        "rect",
        "circle",
        "ellipse",
        "line",
        "polyline",
        "polygon",
        "path",
        "text",
        "tspan",
        "lineargradient",
        "radialgradient",
        "stop",
        "marker",
        "clippath",
        "filter",
        "fedropshadow",
        "fegaussianblur",
        "feoffset",
        "fecomponenttransfer",
        "fefunca",
        "femerge",
        "femergenode",
        "pattern",
    }
)
_DRAWABLE_SVG_TAGS: frozenset[str] = frozenset(
    {"rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text"}
)
_ALLOWED_SVG_ATTRS: frozenset[str] = frozenset(
    {
        "id",
        "role",
        "aria-label",
        "viewbox",
        "width",
        "height",
        "preserveaspectratio",
        "x",
        "y",
        "x1",
        "y1",
        "x2",
        "y2",
        "cx",
        "cy",
        "r",
        "rx",
        "ry",
        "dx",
        "dy",
        "d",
        "points",
        "fill",
        "fill-opacity",
        "fill-rule",
        "stroke",
        "stroke-width",
        "stroke-dasharray",
        "stroke-dashoffset",
        "stroke-linecap",
        "stroke-linejoin",
        "stroke-opacity",
        "opacity",
        "transform",
        "font-family",
        "font-size",
        "font-weight",
        "font-style",
        "text-anchor",
        "dominant-baseline",
        "alignment-baseline",
        "letter-spacing",
        "text-decoration",
        "offset",
        "stop-color",
        "stop-opacity",
        "gradientunits",
        "gradienttransform",
        "markerwidth",
        "markerheight",
        "markerunits",
        "refx",
        "refy",
        "orient",
        "marker-end",
        "marker-start",
        "marker-mid",
        "clip-path",
        "clip-rule",
        "filter",
        "stddeviation",
        "flood-color",
        "flood-opacity",
        "in",
        "in2",
        "result",
        "type",
        "slope",
        "patternunits",
        "xml:space",
    }
)
# Canonical camelCase tag names for SVG serialization
_CANONICAL_TAG_MAP: dict[str, str] = {
    "lineargradient": "linearGradient",
    "radialgradient": "radialGradient",
    "clippath": "clipPath",
    "fedropshadow": "feDropShadow",
    "fegaussianblur": "feGaussianBlur",
    "feoffset": "feOffset",
    "fecomponenttransfer": "feComponentTransfer",
    "fefunca": "feFuncA",
    "femerge": "feMerge",
    "femergenode": "feMergeNode",
}
_CANONICAL_ATTR_MAP: dict[str, str] = {
    "viewbox": "viewBox",
    "preserveaspectratio": "preserveAspectRatio",
    "gradientunits": "gradientUnits",
    "gradienttransform": "gradientTransform",
    "markerwidth": "markerWidth",
    "markerheight": "markerHeight",
    "markerunits": "markerUnits",
    "refx": "refX",
    "refy": "refY",
    "stddeviation": "stdDeviation",
    "patternunits": "patternUnits",
}

_FORBIDDEN_SVG_SUBSTR_RE = re.compile(
    r"<!(?:doctype|entity)|javascript\s*:|vbscript\s*:|data\s*:|expression\s*\(",
    re.IGNORECASE,
)
_EXTERNAL_URL_RE = re.compile(r"(?:https?:|ftp:|file:|//)", re.IGNORECASE)
_LOCAL_URL_REF_RE = re.compile(r"^url\(\s*#[-a-zA-Z0-9_]+\s*\)$")
_URL_CALL_RE = re.compile(r"url\s*\(", re.IGNORECASE)


def _local_name(tag_or_attr: str) -> str:
    if tag_or_attr.startswith("{"):
        return tag_or_attr.split("}", 1)[1]
    return tag_or_attr


def _parse_viewbox(raw_vb: str) -> tuple[float, float, float, float] | None:
    parts = re.split(r"[\s,]+", (raw_vb or "").strip())
    if len(parts) != 4:
        return None
    try:
        vals = tuple(float(p) for p in parts)
    except ValueError:
        return None
    if any(not math.isfinite(v) for v in vals):
        return None
    _vx, _vy, vw, vh = vals
    if not (400.0 <= vw <= 2400.0 and 200.0 <= vh <= 2400.0):
        return None
    return vals  # type: ignore[return-value]


def sanitize_custom_svg(raw_svg: Any) -> str | None:
    """Strictly validate and sanitize an AI-authored `<svg>` string.

    Fail-closed security rules:
      - Rejects DOCTYPE/ENTITY (XXE), malformed XML, non-`<svg>` root, or oversized input.
      - Enforces strict tag whitelist (rejects `<script>`, `<foreignObject>`, `<image>`, `<a>`,
        `<style>`, `<use>`, `<iframe>`, `<animate*>`, etc.).
      - Rejects all `on*` event handlers, `href`/`xlink:href`, `javascript:`/`data:` URIs,
        and any external `http(s)://` or `//` URLs (including inside `url(...)`).
      - Requires a valid readable `viewBox` (`400..2400` x `200..2400`) and >= 3 vector shapes.
    """
    if not isinstance(raw_svg, str):
        return None
    text = raw_svg.strip()
    if not text or len(text.encode("utf-8")) > _MAX_CUSTOM_SVG_BYTES:
        return None
    # Strip optional markdown code fences if the LLM wrapped the SVG
    if text.startswith("```"):
        text = re.sub(r"^```(?:svg|xml)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text).strip()
    if _FORBIDDEN_SVG_SUBSTR_RE.search(text):
        return None

    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return None

    if _local_name(root.tag).lower() != "svg":
        return None

    vb_raw = ""
    for k, v in root.attrib.items():
        if _local_name(k).lower() == "viewbox":
            vb_raw = v
            break
    parsed_vb = _parse_viewbox(vb_raw)
    if parsed_vb is None:
        return None
    vx, vy, vw, vh = parsed_vb

    drawable_count = 0

    def _clean_elem(el: ET.Element) -> ET.Element | None:
        nonlocal drawable_count
        lname = _local_name(el.tag).lower()
        if lname not in _ALLOWED_SVG_TAGS:
            return None
        if lname in _DRAWABLE_SVG_TAGS:
            drawable_count += 1

        clean_tag = _CANONICAL_TAG_MAP.get(lname, lname)
        clean_attrs: dict[str, str] = {}
        for attr_k, attr_v in el.attrib.items():
            # Preserve standard XML space attribute if present
            if attr_k == "{http://www.w3.org/XML/1998/namespace}space":
                alow = "xml:space"
            else:
                alow = _local_name(attr_k).lower()

            # Reject any event handler or external reference attribute immediately
            if alow.startswith("on") or alow in {"href", "src", "style"}:
                return None
            if alow not in _ALLOWED_SVG_ATTRS:
                # Drop harmless unknown metadata attrs only if safe; reject suspicious values
                if _FORBIDDEN_SVG_SUBSTR_RE.search(attr_v) or _EXTERNAL_URL_RE.search(attr_v):
                    return None
                continue

            val = str(attr_v).strip()
            if _FORBIDDEN_SVG_SUBSTR_RE.search(val):
                return None
            if _EXTERNAL_URL_RE.search(val):
                return None
            if _URL_CALL_RE.search(val) and not _LOCAL_URL_REF_RE.match(val):
                return None

            canonical_k = _CANONICAL_ATTR_MAP.get(alow, alow)
            clean_attrs[canonical_k] = val

        new_el = ET.Element(clean_tag, clean_attrs)
        new_el.text = el.text
        new_el.tail = el.tail
        for child in list(el):
            cleaned_child = _clean_elem(child)
            if cleaned_child is None:
                return None
            new_el.append(cleaned_child)
        return new_el

    cleaned_root = _clean_elem(root)
    if cleaned_root is None or drawable_count < 3:
        return None

    # Normalize root SVG attributes for reliable browser & CairoSVG rendering
    vb_str = f"{vx:g} {vy:g} {vw:g} {vh:g}"
    cleaned_root.set("xmlns", _SVG_NS)
    cleaned_root.set("viewBox", vb_str)
    cleaned_root.set("width", f"{vw:g}")
    cleaned_root.set("height", f"{vh:g}")
    cleaned_root.set("role", "img")
    return ET.tostring(cleaned_root, encoding="unicode")


# ── CJK-Aware Vector Text Measurement & Multi-Line Wrapping (Zero Truncation) ─


def _char_width_factor(ch: str) -> float:
    if ch.isspace():
        return 0.30
    if ch in "iIl1.,:;|!'`·":
        return 0.32
    if ch in "()-[]/\\-—–":
        return 0.42
    ea = unicodedata.east_asian_width(ch)
    if ea in ("W", "F"):
        return 1.02
    if ch.isupper():
        return 0.66
    return 0.56


def _estimate_text_width(text: str, font_size: float) -> float:
    return sum(_char_width_factor(ch) for ch in str(text or "")) * font_size


def _wrap_svg_lines(
    text: str, font_size: float, max_width: float, *, max_lines: int = 8
) -> list[str]:
    """Wrap CJK + ASCII text into lines that fit inside `max_width` with ZERO truncation."""
    clean = " ".join(str(text or "").split())
    if not clean:
        return []
    safe_w = max(font_size * 2.2, max_width * 0.94)
    if _estimate_text_width(clean, font_size) <= safe_w:
        return [clean]

    lines: list[str] = []
    remaining = clean
    while remaining:
        if _estimate_text_width(remaining, font_size) <= safe_w or len(lines) >= max_lines - 1:
            # Even at max_lines, keep breaking only if it would wildly overflow; never use "…"
            if _estimate_text_width(remaining, font_size) <= safe_w:
                lines.append(remaining)
                break
        acc = 0.0
        split_at = 0
        for idx, ch in enumerate(remaining):
            w = _char_width_factor(ch) * font_size
            if acc + w > safe_w and idx > 0:
                split_at = idx
                break
            acc += w
        else:
            lines.append(remaining)
            break

        # Avoid splitting an ASCII word/number in the middle
        if (
            0 < split_at < len(remaining)
            and remaining[split_at - 1].isascii()
            and remaining[split_at - 1].isalnum()
            and remaining[split_at].isascii()
            and remaining[split_at].isalnum()
        ):
            back = split_at
            while back > 1 and remaining[back - 1].isascii() and remaining[back - 1].isalnum():
                back -= 1
            if back > 1:
                split_at = back

        # Avoid starting the next line with Chinese/ASCII closing punctuation
        if split_at < len(remaining) and remaining[split_at] in "，。、；：）)】》,.;:)]":
            if split_at + 1 < len(remaining):
                split_at += 1

        chunk = remaining[:split_at].rstrip()
        if not chunk:
            chunk = remaining[:1]
            split_at = 1
        lines.append(chunk)
        remaining = remaining[split_at:].lstrip()

    return lines


def _svg_multiline_text(
    x: float,
    y: float,
    lines: list[str],
    *,
    font_size: float,
    line_height: float,
    fill: str,
    weight: str = "400",
    anchor: str = "start",
) -> str:
    if not lines:
        return ""
    tspans: list[str] = []
    for idx, line in enumerate(lines):
        if idx == 0:
            tspans.append(f'<tspan x="{x:.1f}" dy="0">{_esc(line)}</tspan>')
        else:
            tspans.append(f'<tspan x="{x:.1f}" dy="{line_height:.1f}">{_esc(line)}</tspan>')
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" font-family="{SVG_FONT_STACK}" '
        f'font-size="{font_size:g}" font-weight="{weight}" fill="{fill}" '
        f'text-anchor="{anchor}">{"".join(tspans)}</text>'
    )


def _svg_text(
    x: float,
    y: float,
    text: str,
    *,
    font_size: float,
    fill: str,
    weight: str = "400",
    anchor: str = "start",
    baseline: str | None = None,
) -> str:
    base_attr = f' dominant-baseline="{baseline}"' if baseline else ""
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" font-family="{SVG_FONT_STACK}" '
        f'font-size="{font_size:g}" font-weight="{weight}" fill="{fill}" '
        f'text-anchor="{anchor}"{base_attr}>{_esc(text)}</text>'
    )


def _svg_pill(
    x: float,
    y: float,
    text: str,
    *,
    font_size: float = 13.0,
    bg: str,
    border: str,
    fg: str,
    weight: str = "600",
    pad_x: float = 12.0,
    height: float = 26.0,
) -> tuple[str, float]:
    w = max(height + 12.0, _estimate_text_width(text, font_size) + pad_x * 2)
    r = height / 2.0
    svg = (
        f"<g>"
        f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{height:.1f}" '
        f'rx="{r:.1f}" fill="{bg}" stroke="{border}" stroke-width="1"/>'
        f"{_svg_text(x + w / 2.0, y + height / 2.0 + font_size * 0.35, text, font_size=font_size, fill=fg, weight=weight, anchor='middle')}"
        f"</g>"
    )
    return svg, w


def _svg_defs() -> str:
    return (
        "<defs>"
        '<filter id="cardShadow" x="-4%" y="-6%" width="108%" height="118%">'
        '<feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0F172A" flood-opacity="0.05"/>'
        "</filter>"
        '<marker id="arrowSlate" viewBox="0 0 10 10" refX="8" refY="5" '
        'markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
        '<path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="#64748B"/>'
        "</marker>"
        '<marker id="arrowSky" viewBox="0 0 10 10" refX="8" refY="5" '
        'markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
        '<path d="M 1 1.5 L 8.5 5 L 1 8.5 z" fill="#0284C7"/>'
        "</marker>"
        "</defs>"
    )


def _svg_header_and_frame(
    *,
    width: int,
    tag: str,
    title: str,
    subtitle: str,
    right_badge: str = "",
) -> tuple[list[str], float]:
    """Build top editorial header block and return `(svg_parts, content_start_y)`."""
    parts: list[str] = []
    badge_svg = ""
    badge_w = 0.0
    if right_badge:
        badge_w = _estimate_text_width(right_badge, 13.0) + 28.0
        badge_svg, badge_w = _svg_pill(
            width - 36.0 - badge_w,
            34.0,
            right_badge,
            font_size=13.0,
            bg=BG_SUBTLE,
            border=BORDER_LIGHT,
            fg=TEXT_SECONDARY,
            weight="600",
            pad_x=14.0,
            height=30.0,
        )

    tag_svg, tag_w = _svg_pill(
        52.0,
        24.0,
        tag,
        font_size=13.0,
        bg="#E0F2FE",
        border="#BAE6FD",
        fg="#0369A1",
        weight="700",
        pad_x=12.0,
        height=24.0,
    )

    title_max_w = width - 52.0 - (badge_w + 56.0 if right_badge else 40.0)
    title_lines = _wrap_svg_lines(title, 22.0, title_max_w, max_lines=2)
    title_block_h = max(1, len(title_lines)) * 30.0

    sub_x = 52.0 + tag_w + 12.0
    sub_max_w = width - sub_x - (badge_w + 56.0 if right_badge else 40.0)
    sub_lines = (
        _wrap_svg_lines(subtitle, 13.5, max(200.0, sub_max_w), max_lines=1) if subtitle else []
    )

    header_bottom = 58.0 + title_block_h + 14.0
    # Left vertical accent pill
    parts.append(
        f'<rect x="34" y="24" width="6" height="{header_bottom - 38:.1f}" rx="3" fill="#0284C7"/>'
    )
    parts.append(tag_svg)
    if sub_lines:
        parts.append(
            _svg_text(sub_x, 40.5, sub_lines[0], font_size=13.5, fill=TEXT_MUTED, weight="400")
        )
    parts.append(
        _svg_multiline_text(
            52.0,
            74.0,
            title_lines,
            font_size=22.0,
            line_height=30.0,
            fill=TEXT_PRIMARY,
            weight="700",
        )
    )
    if badge_svg:
        parts.append(badge_svg)
    parts.append(
        f'<line x1="34" y1="{header_bottom:.1f}" x2="{width - 34}" y2="{header_bottom:.1f}" '
        f'stroke="{BORDER_LIGHT}" stroke-width="1.5"/>'
    )
    return parts, header_bottom + 20.0


def _wrap_svg_document(
    width: int, height: float, body_parts: list[str], *, footer_text: str | None = None
) -> str:
    total_h = int(math.ceil(height + 48.0))
    foot = (
        footer_text
        or "数据来源：GroupProof 实时工程事实快照（需求基线 · 任务分工 · GitHub 仓库 · 飞书协作 · 正式证据与成果）"
    )
    footer_y = total_h - 42
    parts = [
        f'<svg xmlns="{_SVG_NS}" viewBox="0 0 {width} {total_h}" '
        f'width="{width}" height="{total_h}" role="img">',
        _svg_defs(),
        f'<rect x="1" y="1" width="{width - 2}" height="{total_h - 2}" rx="16" '
        f'fill="{BG_WHITE}" stroke="{BORDER_LIGHT}" stroke-width="1.5"/>',
        *body_parts,
        f'<line x1="34" y1="{footer_y}" x2="{width - 34}" y2="{footer_y}" '
        f'stroke="{BORDER_LIGHT}" stroke-width="1"/>',
        _svg_text(
            36.0,
            footer_y + 24.0,
            foot,
            font_size=12.0,
            fill=TEXT_LIGHT,
            weight="400",
        ),
        "</svg>",
    ]
    return "".join(parts)


# ── Template 1: Layered Architecture (Pure Vector SVG, Zero Truncation) ──────


def _render_layered_architecture_svg(spec: dict[str, Any], facts: dict[str, Any]) -> str:
    payload = spec.get("payload") if isinstance(spec.get("payload"), dict) else {}
    layers = payload.get("layers") if isinstance(payload.get("layers"), list) else []
    if not layers:
        layers = _default_architecture_payload(facts)["layers"]
    layers = [ly for ly in layers if isinstance(ly, dict)][:4]

    proj = facts.get("project") if isinstance(facts.get("project"), dict) else {}
    counts = facts.get("counts") if isinstance(facts.get("counts"), dict) else {}
    right_badge = (
        f"{proj.get('modules_count', len(facts.get('modules') or []))} 模块 · "
        f"{counts.get('tasks', 0)} 任务 · {counts.get('members', 0)} 成员"
    )

    body, cursor_y = _svg_header_and_frame(
        width=CANVAS_WIDTH,
        tag=str(spec.get("badge") or "系统架构"),
        title=str(spec.get("title") or "系统架构与模块分工总览图"),
        subtitle=str(spec.get("subtitle") or proj.get("name") or ""),
        right_badge=right_badge,
    )

    pad_x = 34.0
    inner_w = CANVAS_WIDTH - pad_x * 2
    layer_gap = 34.0

    for l_idx, ly in enumerate(layers):
        acc = _accent(ly.get("accent"), l_idx)
        nodes = [n for n in (ly.get("nodes") or []) if isinstance(n, dict)][:8]
        if not nodes:
            nodes = [{"title": str(ly.get("name") or "核心组件"), "subtitle": "核心服务"}]

        # Max 4 columns so long Chinese module titles breathe without truncation
        cols = min(len(nodes), 4)
        if len(nodes) == 5:
            cols = 3  # 3 + 2 balanced rows instead of 5 cramped skinny boxes
        rows = (len(nodes) + cols - 1) // cols

        card_gap_x = 14.0
        card_gap_y = 14.0
        grid_x = pad_x + 22.0
        grid_w = inner_w - 38.0
        card_w = (grid_w - card_gap_x * (cols - 1)) / max(1, cols)

        # Pre-measure every node's wrapped lines to compute exact non-truncating row heights
        measured_nodes: list[dict[str, Any]] = []
        row_heights: list[float] = [0.0] * rows
        for n_idx, node in enumerate(nodes):
            title_lines = _wrap_svg_lines(
                str(node.get("title") or f"模块 {n_idx + 1}"), 15.0, card_w - 28.0, max_lines=4
            )
            sub_str = str(node.get("subtitle") or "")
            sub_lines = (
                _wrap_svg_lines(sub_str, 13.0, card_w - 28.0, max_lines=4) if sub_str else []
            )
            metric_str = str(node.get("metric") or "")
            progress = node.get("progress")

            content_h = 18.0 + len(title_lines) * 21.0
            if sub_lines:
                content_h += 6.0 + len(sub_lines) * 19.0
            if progress is not None:
                content_h += (26.0 if metric_str else 12.0) + 18.0
            elif metric_str:
                content_h += 24.0
            content_h += 14.0
            card_h = max(92.0, content_h)

            r = n_idx // cols
            row_heights[r] = max(row_heights[r], card_h)
            measured_nodes.append(
                {
                    "node": node,
                    "title_lines": title_lines,
                    "sub_lines": sub_lines,
                    "metric": metric_str,
                    "progress": progress,
                }
            )

        layer_name = str(ly.get("name") or f"层级 {l_idx + 1}")
        layer_h = 48.0 + sum(row_heights) + card_gap_y * max(0, rows - 1) + 18.0
        y1 = cursor_y
        y2 = y1 + layer_h

        # Layer outer container
        bg_fill = BG_SUBTLE if l_idx % 2 == 1 else BG_WHITE
        stroke_col = acc["border"] if l_idx == 0 else BORDER_MED
        body.append(
            f'<rect x="{pad_x:.1f}" y="{y1:.1f}" width="{inner_w:.1f}" height="{layer_h:.1f}" '
            f'rx="14" fill="{bg_fill}" stroke="{stroke_col}" stroke-width="1.5"/>'
        )
        # Left semantic accent strip
        body.append(
            f'<rect x="{pad_x:.1f}" y="{y1:.1f}" width="7" height="{layer_h:.1f}" '
            f'rx="3.5" fill="{acc["main"]}"/>'
        )
        body.append(
            _svg_text(
                pad_x + 22.0,
                y1 + 29.0,
                layer_name,
                font_size=15.5,
                fill=acc["text"],
                weight="700",
            )
        )

        # Render cards per row (center last partial row cleanly)
        row_y = y1 + 46.0
        for r in range(rows):
            row_items = measured_nodes[r * cols : (r + 1) * cols]
            actual_cols = len(row_items)
            row_card_w = (grid_w - card_gap_x * (actual_cols - 1)) / max(1, actual_cols)
            rh = row_heights[r]
            for c, item in enumerate(row_items):
                n_idx = r * cols + c
                node = item["node"]
                n_acc = _accent(
                    node.get("accent")
                    or (
                        ACCENT_CYCLE[n_idx % 4]
                        if l_idx == 1 and len(nodes) <= 4
                        else ly.get("accent")
                    ),
                    l_idx + n_idx,
                )
                cx1 = grid_x + c * (row_card_w + card_gap_x)
                cy1 = row_y
                cy2 = cy1 + rh

                # Re-wrap if partial row gave wider cards
                t_lines = (
                    _wrap_svg_lines(
                        str(node.get("title") or f"模块 {n_idx + 1}"),
                        15.0,
                        row_card_w - 28.0,
                        max_lines=4,
                    )
                    if actual_cols != cols
                    else item["title_lines"]
                )
                s_lines = (
                    _wrap_svg_lines(
                        str(node.get("subtitle") or ""),
                        13.0,
                        row_card_w - 28.0,
                        max_lines=4,
                    )
                    if (actual_cols != cols and node.get("subtitle"))
                    else item["sub_lines"]
                )

                body.append(
                    f'<g filter="url(#cardShadow)">'
                    f'<rect x="{cx1:.1f}" y="{cy1:.1f}" width="{row_card_w:.1f}" height="{rh:.1f}" '
                    f'rx="10" fill="{BG_WHITE}" stroke="{BORDER_LIGHT}" stroke-width="1.2"/>'
                    f'<rect x="{cx1 + 1:.1f}" y="{cy1 + 1:.1f}" width="{row_card_w - 2:.1f}" height="4.5" '
                    f'rx="2.5" fill="{n_acc["main"]}"/>'
                    f"</g>"
                )
                body.append(
                    _svg_multiline_text(
                        cx1 + 14.0,
                        cy1 + 29.0,
                        t_lines,
                        font_size=15.0,
                        line_height=21.0,
                        fill=TEXT_PRIMARY,
                        weight="700",
                    )
                )
                sub_start_y = cy1 + 29.0 + len(t_lines) * 21.0 + 3.0
                if s_lines:
                    body.append(
                        _svg_multiline_text(
                            cx1 + 14.0,
                            sub_start_y,
                            s_lines,
                            font_size=13.0,
                            line_height=19.0,
                            fill=TEXT_MUTED,
                            weight="400",
                        )
                    )

                metric = item["metric"]
                progress = item["progress"]
                if progress is not None:
                    pct = max(0, min(100, _safe_int(progress)))
                    bar_y = cy2 - 20.0
                    bar_w = row_card_w - 28.0
                    if metric:
                        body.append(
                            _svg_text(
                                cx1 + 14.0,
                                bar_y - 8.0,
                                metric,
                                font_size=13.0,
                                fill=n_acc["text"],
                                weight="700",
                            )
                        )
                    body.append(
                        f'<rect x="{cx1 + 14:.1f}" y="{bar_y:.1f}" width="{bar_w:.1f}" height="8" '
                        f'rx="4" fill="{BG_TRACK}"/>'
                    )
                    if pct > 0:
                        fw = max(8.0, bar_w * pct / 100.0)
                        body.append(
                            f'<rect x="{cx1 + 14:.1f}" y="{bar_y:.1f}" width="{fw:.1f}" height="8" '
                            f'rx="4" fill="{n_acc["main"]}"/>'
                        )
                elif metric:
                    body.append(
                        _svg_text(
                            cx1 + 14.0,
                            cy2 - 14.0,
                            metric,
                            font_size=13.0,
                            fill=n_acc["text"],
                            weight="700",
                        )
                    )
            row_y += rh + card_gap_y

        # Smooth Bézier downward connectors between layers
        if l_idx < len(layers) - 1:
            cy_start = y2 + 3.0
            cy_end = y2 + layer_gap - 5.0
            for ratio in (0.25, 0.5, 0.75):
                ax = pad_x + inner_w * ratio
                body.append(
                    f'<path d="M {ax:.1f} {cy_start:.1f} C {ax:.1f} {(cy_start + cy_end) / 2:.1f}, '
                    f'{ax:.1f} {(cy_start + cy_end) / 2:.1f}, {ax:.1f} {cy_end:.1f}" '
                    f'fill="none" stroke="#94A3B8" stroke-width="2" marker-end="url(#arrowSlate)"/>'
                )

        cursor_y = y2 + layer_gap

    return _wrap_svg_document(
        CANVAS_WIDTH, cursor_y - layer_gap + 16.0, body, footer_text=payload.get("footer")
    )


# ── Template 2: Process / Workflow Pipeline (1-Row or 2-Row Snake Bézier) ────


def _render_process_flow_svg(spec: dict[str, Any], facts: dict[str, Any]) -> str:
    payload = spec.get("payload") if isinstance(spec.get("payload"), dict) else {}
    steps = payload.get("steps") if isinstance(payload.get("steps"), list) else []
    if not steps:
        steps = _default_workflow_payload(facts)["steps"]
    steps = [s for s in steps if isinstance(s, dict)][:6]
    if not steps:
        steps = [{"step": "01", "title": "项目实施", "metric": "进行中", "detail": ""}]

    kpis = [k for k in (payload.get("kpis") or []) if isinstance(k, dict)][:4]
    footer_note = str(
        payload.get("footer_note")
        or "过程核验机制：需求基线冻结与任务验收标准绑定真实代码/文档证据，确保进度可复核、责任可追溯。"
    )

    proj = facts.get("project") if isinstance(facts.get("project"), dict) else {}
    body, cursor_y = _svg_header_and_frame(
        width=CANVAS_WIDTH,
        tag=str(spec.get("badge") or "研发流程"),
        title=str(spec.get("title") or "证据驱动的研发协作与验收流程图"),
        subtitle=str(spec.get("subtitle") or proj.get("name") or ""),
        right_badge=f"全周期 {len(steps)} 阶段协同",
    )

    pad_x = 34.0
    total_w = CANVAS_WIDTH - pad_x * 2
    n = len(steps)
    # 2 neat rows of 3 cards when 5-6 steps -> wide 356px cards with zero cramped text!
    cols = 3 if n >= 5 else n
    rows = (n + cols - 1) // cols
    arrow_gap = 32.0
    row_gap = 36.0
    card_w = (total_w - arrow_gap * (cols - 1)) / cols

    # Measure card height per row
    measured: list[dict[str, Any]] = []
    row_heights: list[float] = [0.0] * rows
    for idx, st in enumerate(steps):
        t_lines = _wrap_svg_lines(
            str(st.get("title") or f"阶段 {idx + 1}"), 16.5, card_w - 32.0, max_lines=2
        )
        m_lines = _wrap_svg_lines(str(st.get("metric") or "—"), 17.0, card_w - 40.0, max_lines=2)
        d_lines = _wrap_svg_lines(str(st.get("detail") or ""), 13.5, card_w - 32.0, max_lines=4)
        metric_box_h = max(44.0, len(m_lines) * 23.0 + 18.0)
        h = (
            20.0
            + 26.0
            + 12.0
            + len(t_lines) * 23.0
            + 12.0
            + metric_box_h
            + 14.0
            + len(d_lines) * 20.0
            + 16.0
        )
        r = idx // cols
        row_heights[r] = max(row_heights[r], max(195.0, h))
        measured.append(
            {
                "st": st,
                "t_lines": t_lines,
                "m_lines": m_lines,
                "d_lines": d_lines,
                "metric_box_h": metric_box_h,
            }
        )

    card_positions: list[tuple[float, float, float, float]] = []
    cur_y = cursor_y + 4.0
    for r in range(rows):
        rh = row_heights[r]
        row_items = measured[r * cols : (r + 1) * cols]
        for c, item in enumerate(row_items):
            idx = r * cols + c
            st = item["st"]
            acc = _accent(st.get("accent"), idx)
            x1 = pad_x + c * (card_w + arrow_gap)
            y1 = cur_y
            card_positions.append((x1, y1, card_w, rh))

            body.append(
                f'<g filter="url(#cardShadow)">'
                f'<rect x="{x1:.1f}" y="{y1:.1f}" width="{card_w:.1f}" height="{rh:.1f}" '
                f'rx="12" fill="{BG_SUBTLE}" stroke="{BORDER_LIGHT}" stroke-width="1.3"/>'
                f'<rect x="{x1 + 1:.1f}" y="{y1 + 1:.1f}" width="{card_w - 2:.1f}" height="5" '
                f'rx="2.5" fill="{acc["main"]}"/>'
                f"</g>"
            )

            step_code = str(st.get("step") or f"{idx + 1:02d}")
            pill_svg, _ = _svg_pill(
                x1 + 16.0,
                y1 + 18.0,
                f"STEP {step_code}",
                font_size=12.5,
                bg=acc["soft"],
                border=acc["border"],
                fg=acc["text"],
                weight="700",
                pad_x=10.0,
                height=24.0,
            )
            body.append(pill_svg)

            title_y = y1 + 64.0
            body.append(
                _svg_multiline_text(
                    x1 + 16.0,
                    title_y,
                    item["t_lines"],
                    font_size=16.5,
                    line_height=23.0,
                    fill=TEXT_PRIMARY,
                    weight="700",
                )
            )

            m_y1 = title_y + len(item["t_lines"]) * 23.0 - 4.0
            m_h = item["metric_box_h"]
            body.append(
                f'<rect x="{x1 + 14:.1f}" y="{m_y1:.1f}" width="{card_w - 28:.1f}" height="{m_h:.1f}" '
                f'rx="9" fill="{BG_WHITE}" stroke="{acc["border"]}" stroke-width="1.2"/>'
            )
            m_text_y = m_y1 + (m_h - (len(item["m_lines"]) - 1) * 22.0) / 2.0 + 6.0
            body.append(
                _svg_multiline_text(
                    x1 + card_w / 2.0,
                    m_text_y,
                    item["m_lines"],
                    font_size=16.5,
                    line_height=22.0,
                    fill=acc["main"],
                    weight="700",
                    anchor="middle",
                )
            )

            if item["d_lines"]:
                body.append(
                    _svg_multiline_text(
                        x1 + 16.0,
                        m_y1 + m_h + 22.0,
                        item["d_lines"],
                        font_size=13.5,
                        line_height=20.0,
                        fill=TEXT_SECONDARY,
                        weight="400",
                    )
                )

            # Horizontal arrow to next card in same row
            if c < len(row_items) - 1:
                ax1 = x1 + card_w + 4.0
                ax2 = x1 + card_w + arrow_gap - 5.0
                ay = y1 + rh / 2.0
                body.append(
                    f'<path d="M {ax1:.1f} {ay:.1f} L {ax2:.1f} {ay:.1f}" '
                    f'fill="none" stroke="#64748B" stroke-width="2" marker-end="url(#arrowSlate)"/>'
                )

        # Smooth S-curve connector from end of row 0 to start of row 1
        if r < rows - 1 and len(row_items) > 0:
            end_x = pad_x + (len(row_items) - 1) * (card_w + arrow_gap) + card_w / 2.0
            end_y = cur_y + rh + 2.0
            next_x = pad_x + card_w / 2.0
            next_y = cur_y + rh + row_gap - 5.0
            mid_y = (end_y + next_y) / 2.0
            body.append(
                f'<path d="M {end_x:.1f} {end_y:.1f} C {end_x:.1f} {mid_y + 10:.1f}, '
                f'{next_x:.1f} {mid_y - 10:.1f}, {next_x:.1f} {next_y:.1f}" '
                f'fill="none" stroke="#0284C7" stroke-width="2" stroke-dasharray="5 4" '
                f'marker-end="url(#arrowSky)"/>'
            )

        cur_y += rh + row_gap

    # Bottom governance & KPI band
    band_y1 = cur_y - row_gap + 22.0
    kpi_zone_w = min(540.0, len(kpis) * 136.0) if kpis else 0.0
    note_w = total_w - (kpi_zone_w + 40.0 if kpis else 36.0)
    note_lines = _wrap_svg_lines(footer_note, 13.5, note_w, max_lines=3)
    band_h = max(72.0, len(note_lines) * 21.0 + 30.0)

    body.append(
        f'<rect x="{pad_x:.1f}" y="{band_y1:.1f}" width="{total_w:.1f}" height="{band_h:.1f}" '
        f'rx="12" fill="#F0F9FF" stroke="#BAE6FD" stroke-width="1.2"/>'
    )
    note_start_y = band_y1 + (band_h - (len(note_lines) - 1) * 21.0) / 2.0 + 4.5
    body.append(
        _svg_multiline_text(
            pad_x + 18.0,
            note_start_y,
            note_lines,
            font_size=13.5,
            line_height=21.0,
            fill="#0C4A6E",
            weight="500",
        )
    )

    if kpis:
        kx = CANVAS_WIDTH - pad_x - kpi_zone_w - 12.0
        kw = (kpi_zone_w - 10.0 * (len(kpis) - 1)) / len(kpis)
        for ki, kpi in enumerate(kpis):
            bx1 = kx + ki * (kw + 10.0)
            by1 = band_y1 + 10.0
            bh = band_h - 20.0
            body.append(
                f'<rect x="{bx1:.1f}" y="{by1:.1f}" width="{kw:.1f}" height="{bh:.1f}" '
                f'rx="8" fill="{BG_WHITE}" stroke="#BAE6FD" stroke-width="1"/>'
            )
            body.append(
                _svg_text(
                    bx1 + kw / 2.0,
                    by1 + bh * 0.44,
                    str(kpi.get("value") or "—"),
                    font_size=16.5,
                    fill="#0284C7",
                    weight="700",
                    anchor="middle",
                )
            )
            body.append(
                _svg_text(
                    bx1 + kw / 2.0,
                    by1 + bh * 0.78,
                    str(kpi.get("label") or ""),
                    font_size=12.5,
                    fill=TEXT_MUTED,
                    weight="400",
                    anchor="middle",
                )
            )

    return _wrap_svg_document(
        CANVAS_WIDTH, band_y1 + band_h + 16.0, body, footer_text=payload.get("footer")
    )


# ── Template 3: Milestone / Stage Timeline ────────────────────────────────────


def _render_milestone_timeline_svg(spec: dict[str, Any], facts: dict[str, Any]) -> str:
    payload = spec.get("payload") if isinstance(spec.get("payload"), dict) else {}
    items = payload.get("items") if isinstance(payload.get("items"), list) else []
    if not items:
        payload = _default_milestones_payload(facts)
        items = payload.get("items") or []
    items = [it for it in items if isinstance(it, dict)][:10]
    summary_badges = [b for b in (payload.get("summary_badges") or []) if isinstance(b, dict)][:4]

    proj = facts.get("project") if isinstance(facts.get("project"), dict) else {}
    body, cursor_y = _svg_header_and_frame(
        width=CANVAS_WIDTH,
        tag=str(spec.get("badge") or "阶段进度"),
        title=str(spec.get("title") or "阶段里程碑推进与任务完成进度图"),
        subtitle=str(spec.get("subtitle") or proj.get("name") or ""),
        right_badge=f"共 {len(items)} 个关键节点",
    )

    pad_x = 34.0
    total_w = CANVAS_WIDTH - pad_x * 2

    if summary_badges:
        bw = (total_w - 14.0 * (len(summary_badges) - 1)) / len(summary_badges)
        for bi, b in enumerate(summary_badges):
            acc = _accent(b.get("accent"), bi)
            bx = pad_x + bi * (bw + 14.0)
            body.append(
                f'<rect x="{bx:.1f}" y="{cursor_y:.1f}" width="{bw:.1f}" height="56" '
                f'rx="10" fill="{BG_SUBTLE}" stroke="{acc["border"]}" stroke-width="1.2"/>'
            )
            body.append(
                f'<rect x="{bx:.1f}" y="{cursor_y:.1f}" width="6" height="56" '
                f'rx="3" fill="{acc["main"]}"/>'
            )
            body.append(
                _svg_text(
                    bx + 18.0,
                    cursor_y + 22.0,
                    str(b.get("label") or ""),
                    font_size=13.0,
                    fill=TEXT_MUTED,
                    weight="500",
                )
            )
            body.append(
                _svg_text(
                    bx + 18.0,
                    cursor_y + 44.0,
                    str(b.get("value") or "—"),
                    font_size=18.0,
                    fill=acc["text"],
                    weight="700",
                )
            )
        cursor_y += 74.0

    # Timeline column geometry
    spine_x = pad_x + 14.0
    label_x = pad_x + 38.0
    label_w = 430.0
    date_x = label_x + label_w + 16.0
    bar_x = date_x + 106.0
    bar_w = 340.0
    pct_x = bar_x + bar_w + 14.0
    status_x = pct_x + 56.0

    # Subtle column header
    body.append(
        _svg_text(
            label_x,
            cursor_y + 12.0,
            "里程碑阶段与交付摘要",
            font_size=13.0,
            fill=TEXT_LIGHT,
            weight="600",
        )
    )
    body.append(
        _svg_text(
            date_x, cursor_y + 12.0, "截止日期", font_size=13.0, fill=TEXT_LIGHT, weight="600"
        )
    )
    body.append(
        _svg_text(bar_x, cursor_y + 12.0, "完成进度", font_size=13.0, fill=TEXT_LIGHT, weight="600")
    )
    body.append(
        _svg_text(status_x, cursor_y + 12.0, "状态", font_size=13.0, fill=TEXT_LIGHT, weight="600")
    )
    cursor_y += 24.0

    row_centers: list[float] = []
    row_blocks: list[str] = []
    for idx, it in enumerate(items):
        acc = _accent(it.get("tone"), idx)
        title_lines = _wrap_svg_lines(
            str(it.get("label") or f"阶段 {idx + 1}"), 14.5, label_w, max_lines=2
        )
        meta_str = str(it.get("meta") or "")
        meta_lines = _wrap_svg_lines(meta_str, 13.0, label_w, max_lines=2) if meta_str else []
        row_h = max(
            58.0,
            14.0
            + len(title_lines) * 20.0
            + (6.0 + len(meta_lines) * 18.0 if meta_lines else 0.0)
            + 12.0,
        )
        y1 = cursor_y
        cy = y1 + row_h / 2.0
        row_centers.append(cy)

        row_bg = BG_SUBTLE if idx % 2 == 0 else BG_WHITE
        row_blocks.append(
            f'<rect x="{pad_x + 28:.1f}" y="{y1:.1f}" width="{total_w - 28:.1f}" height="{row_h:.1f}" '
            f'rx="10" fill="{row_bg}" stroke="{BORDER_LIGHT}" stroke-width="1"/>'
        )
        # Dot on spine
        row_blocks.append(
            f'<circle cx="{spine_x:.1f}" cy="{cy:.1f}" r="7" fill="{acc["soft"]}" '
            f'stroke="{acc["main"]}" stroke-width="2.5"/>'
        )
        row_blocks.append(
            _svg_multiline_text(
                label_x,
                y1 + 26.0,
                title_lines,
                font_size=14.5,
                line_height=20.0,
                fill=TEXT_PRIMARY,
                weight="600",
            )
        )
        if meta_lines:
            row_blocks.append(
                _svg_multiline_text(
                    label_x,
                    y1 + 26.0 + len(title_lines) * 20.0 + 2.0,
                    meta_lines,
                    font_size=13.0,
                    line_height=18.0,
                    fill=TEXT_MUTED,
                    weight="400",
                )
            )
        date_str = str(it.get("date") or "—")
        row_blocks.append(
            _svg_text(date_x, cy + 5.0, date_str, font_size=13.0, fill=TEXT_MUTED, weight="500")
        )

        pct = max(0, min(100, _safe_int(it.get("progress"), 0)))
        row_blocks.append(
            f'<rect x="{bar_x:.1f}" y="{cy - 6:.1f}" width="{bar_w:.1f}" height="12" rx="6" fill="{BG_TRACK}"/>'
        )
        if pct > 0:
            fw = max(10.0, bar_w * pct / 100.0)
            row_blocks.append(
                f'<rect x="{bar_x:.1f}" y="{cy - 6:.1f}" width="{fw:.1f}" height="12" rx="6" fill="{acc["main"]}"/>'
            )
        row_blocks.append(
            _svg_text(
                pct_x,
                cy + 5.0,
                f"{pct}%",
                font_size=13.5,
                fill=TEXT_PRIMARY,
                weight="700",
            )
        )
        status_pill, _ = _svg_pill(
            status_x,
            cy - 13.0,
            str(it.get("status") or "进行中"),
            font_size=12.5,
            bg=acc["soft"],
            border=acc["border"],
            fg=acc["text"],
            weight="600",
            pad_x=10.0,
            height=26.0,
        )
        row_blocks.append(status_pill)
        cursor_y += row_h + 10.0

    # Vertical timeline spine connecting dots (placed behind dots)
    if len(row_centers) >= 2:
        body.append(
            f'<line x1="{spine_x:.1f}" y1="{row_centers[0]:.1f}" x2="{spine_x:.1f}" '
            f'y2="{row_centers[-1]:.1f}" stroke="{BORDER_MED}" stroke-width="2.5"/>'
        )
    body.extend(row_blocks)
    return _wrap_svg_document(CANVAS_WIDTH, cursor_y + 8.0, body, footer_text=payload.get("footer"))


# ── Template 4: Category Breakdown (1 or 2 Panels, Ranked Horizontal Bars) ───


def _render_category_breakdown_svg(spec: dict[str, Any], facts: dict[str, Any]) -> str:
    payload = spec.get("payload") if isinstance(spec.get("payload"), dict) else {}
    panels = payload.get("panels") if isinstance(payload.get("panels"), list) else []
    if not panels:
        panels = _default_evidence_payload(facts)["panels"]
    panels = [p for p in panels if isinstance(p, dict)][:2]

    proj = facts.get("project") if isinstance(facts.get("project"), dict) else {}
    body, cursor_y = _svg_header_and_frame(
        width=CANVAS_WIDTH,
        tag=str(spec.get("badge") or "统计分布"),
        title=str(spec.get("title") or "正式证据来源分布与飞书协作结论结构图"),
        subtitle=str(spec.get("subtitle") or proj.get("name") or ""),
        right_badge=f"{len(panels)} 组分布视图",
    )

    pad_x = 34.0
    total_w = CANVAS_WIDTH - pad_x * 2
    panel_gap = 20.0
    panel_w = (total_w - panel_gap * (len(panels) - 1)) / max(1, len(panels))

    # Measure required height across panels so both panels share a balanced bottom edge
    panel_heights: list[float] = []
    for p in panels:
        p_items = [it for it in (p.get("items") or []) if isinstance(it, dict)][:8]
        rows_h = max(1, len(p_items)) * 56.0 if p_items else 110.0
        foot_lines = (
            _wrap_svg_lines(str(p.get("footnote") or ""), 13.0, panel_w - 36.0, max_lines=2)
            if p.get("footnote")
            else []
        )
        foot_h = (len(foot_lines) * 19.0 + 24.0) if foot_lines else 16.0
        panel_heights.append(72.0 + rows_h + foot_h + 12.0)

    unified_h = max(290.0, max(panel_heights, default=290.0))

    for p_idx, panel in enumerate(panels):
        acc = _accent(panel.get("accent"), p_idx)
        px = pad_x + p_idx * (panel_w + panel_gap)
        py = cursor_y
        body.append(
            f'<g filter="url(#cardShadow)">'
            f'<rect x="{px:.1f}" y="{py:.1f}" width="{panel_w:.1f}" height="{unified_h:.1f}" '
            f'rx="14" fill="{BG_WHITE}" stroke="{BORDER_LIGHT}" stroke-width="1.4"/>'
            f'<rect x="{px + 1:.1f}" y="{py + 1:.1f}" width="{panel_w - 2:.1f}" height="5" '
            f'rx="2.5" fill="{acc["main"]}"/>'
            f"</g>"
        )
        body.append(
            _svg_text(
                px + 20.0,
                py + 34.0,
                str(panel.get("title") or f"统计面板 {p_idx + 1}"),
                font_size=16.0,
                fill=TEXT_PRIMARY,
                weight="700",
            )
        )
        total_lbl = str(panel.get("total_label") or "")
        if total_lbl:
            tw = _estimate_text_width(total_lbl, 12.5) + 22.0
            pill_svg, _ = _svg_pill(
                px + panel_w - 20.0 - tw,
                py + 16.0,
                total_lbl,
                font_size=12.5,
                bg=acc["soft"],
                border=acc["border"],
                fg=acc["text"],
                weight="600",
                pad_x=11.0,
                height=26.0,
            )
            body.append(pill_svg)

        body.append(
            f'<line x1="{px + 20:.1f}" y1="{py + 54:.1f}" x2="{px + panel_w - 20:.1f}" '
            f'y2="{py + 54:.1f}" stroke="{BORDER_LIGHT}" stroke-width="1"/>'
        )

        p_items = [it for it in (panel.get("items") or []) if isinstance(it, dict)][:8]
        if not p_items:
            empty_msg = str(panel.get("empty_message") or "暂无统计数据")
            body.append(
                _svg_text(
                    px + panel_w / 2.0,
                    py + unified_h / 2.0,
                    empty_msg,
                    font_size=14.0,
                    fill=TEXT_LIGHT,
                    weight="400",
                    anchor="middle",
                )
            )
        else:
            max_val = max((_safe_num(it.get("value"), 0.0) for it in p_items), default=1.0) or 1.0
            sum_val = sum(_safe_num(it.get("value"), 0.0) for it in p_items) or 1.0
            iy = py + 74.0
            bar_w = panel_w - 40.0
            for i_idx, it in enumerate(p_items):
                i_acc = _accent(it.get("accent"), p_idx * 2 + i_idx)
                val = _safe_num(it.get("value"), 0.0)
                unit = str(it.get("unit") or "")
                val_txt = f"{int(val) if val == int(val) else round(val, 1)}{unit}"
                pct = round(val * 100.0 / sum_val, 1)
                lbl = str(it.get("label") or f"类别 {i_idx + 1}")

                body.append(
                    _svg_text(
                        px + 20.0, iy + 12.0, lbl, font_size=14.0, fill=TEXT_PRIMARY, weight="600"
                    )
                )
                body.append(
                    _svg_text(
                        px + panel_w - 20.0,
                        iy + 12.0,
                        f"{val_txt}（{pct:.1f}%）",
                        font_size=13.5,
                        fill=i_acc["text"],
                        weight="700",
                        anchor="end",
                    )
                )
                body.append(
                    f'<rect x="{px + 20:.1f}" y="{iy + 22:.1f}" width="{bar_w:.1f}" '
                    f'height="12" rx="6" fill="{BG_TRACK}"/>'
                )
                if val > 0:
                    fw = max(12.0, bar_w * (val / max_val))
                    body.append(
                        f'<rect x="{px + 20:.1f}" y="{iy + 22:.1f}" width="{fw:.1f}" '
                        f'height="12" rx="6" fill="{i_acc["main"]}"/>'
                    )
                iy += 54.0

        footnote = str(panel.get("footnote") or "")
        if footnote:
            f_lines = _wrap_svg_lines(footnote, 13.0, panel_w - 56.0, max_lines=2)
            fh = len(f_lines) * 19.0 + 16.0
            fy = py + unified_h - fh - 14.0
            body.append(
                f'<rect x="{px + 18:.1f}" y="{fy:.1f}" width="{panel_w - 36:.1f}" '
                f'height="{fh:.1f}" rx="8" fill="{BG_SUBTLE}" stroke="{BORDER_LIGHT}" stroke-width="1"/>'
            )
            body.append(
                _svg_multiline_text(
                    px + 28.0,
                    fy + 21.0,
                    f_lines,
                    font_size=13.0,
                    line_height=19.0,
                    fill=TEXT_MUTED,
                    weight="500",
                )
            )

    return _wrap_svg_document(
        CANVAS_WIDTH, cursor_y + unified_h + 18.0, body, footer_text=payload.get("footer")
    )


# ── Template 5: Member Multi-Dimensional Comparison ──────────────────────────


def _render_member_comparison_svg(spec: dict[str, Any], facts: dict[str, Any]) -> str:
    payload = spec.get("payload") if isinstance(spec.get("payload"), dict) else {}
    series = [s for s in (payload.get("series") or []) if isinstance(s, dict)][:4]
    members = [m for m in (payload.get("members") or []) if isinstance(m, dict)][:8]
    if not series or not members:
        default_pl = _default_contribution_payload(facts)
        series = default_pl["series"]
        members = default_pl["members"]

    proj = facts.get("project") if isinstance(facts.get("project"), dict) else {}
    body, cursor_y = _svg_header_and_frame(
        width=CANVAS_WIDTH,
        tag=str(spec.get("badge") or "成员贡献"),
        title=str(spec.get("title") or "团队成员多维贡献与分工对比图"),
        subtitle=str(spec.get("subtitle") or proj.get("name") or ""),
        right_badge=f"{len(members)} 名成员 · {len(series)} 维指标",
    )

    pad_x = 34.0
    total_w = CANVAS_WIDTH - pad_x * 2

    # Legend bar
    lx = pad_x + 4.0
    for s_idx, ser in enumerate(series):
        s_acc = _accent(ser.get("accent"), s_idx)
        lbl = str(ser.get("label") or ser.get("key") or f"维度 {s_idx + 1}")
        body.append(
            f'<rect x="{lx:.1f}" y="{cursor_y + 2:.1f}" width="14" height="14" rx="4" fill="{s_acc["main"]}"/>'
        )
        body.append(
            _svg_text(
                lx + 20.0, cursor_y + 14.0, lbl, font_size=13.5, fill=TEXT_SECONDARY, weight="600"
            )
        )
        lx += 20.0 + _estimate_text_width(lbl, 13.5) + 26.0
    cursor_y += 34.0

    # Series maxima for proportional bars
    series_max: dict[str, float] = {}
    for ser in series:
        skey = str(ser.get("key") or "")
        mx = 0.0
        for m in members:
            vals = m.get("values") if isinstance(m.get("values"), dict) else {}
            entry = vals.get(skey)
            val = _safe_num(entry.get("value") if isinstance(entry, dict) else entry, 0.0)
            mx = max(mx, val)
        series_max[skey] = mx if mx > 0 else 1.0

    left_col_w = 340.0
    right_x = pad_x + left_col_w + 24.0
    bar_label_w = 138.0
    val_col_w = 128.0
    bar_x = right_x + bar_label_w
    bar_w = total_w - left_col_w - 24.0 - bar_label_w - val_col_w - 20.0

    for m_idx, member in enumerate(members):
        name = str(member.get("name") or f"成员 {m_idx + 1}")
        role = str(member.get("role") or "成员")
        subtitle = str(member.get("subtitle") or "")
        sub_lines = (
            _wrap_svg_lines(subtitle, 13.0, left_col_w - 72.0, max_lines=3) if subtitle else []
        )

        left_h = 22.0 + 26.0 + len(sub_lines) * 19.0 + 18.0
        right_h = 20.0 + len(series) * 28.0 + 12.0
        card_h = max(108.0, left_h, right_h)

        y1 = cursor_y
        acc_m = _accent(None, m_idx)
        body.append(
            f'<g filter="url(#cardShadow)">'
            f'<rect x="{pad_x:.1f}" y="{y1:.1f}" width="{total_w:.1f}" height="{card_h:.1f}" '
            f'rx="12" fill="{BG_WHITE}" stroke="{BORDER_LIGHT}" stroke-width="1.3"/>'
            f'<rect x="{pad_x:.1f}" y="{y1:.1f}" width="6" height="{card_h:.1f}" '
            f'rx="3" fill="{acc_m["main"]}"/>'
            f"</g>"
        )
        # Vertical divider between identity & metrics
        body.append(
            f'<line x1="{pad_x + left_col_w + 6:.1f}" y1="{y1 + 14:.1f}" '
            f'x2="{pad_x + left_col_w + 6:.1f}" y2="{y1 + card_h - 14:.1f}" '
            f'stroke="{BORDER_LIGHT}" stroke-width="1"/>'
        )

        # Avatar circle with initial
        initial = name[:1] if name else "员"
        body.append(
            f'<circle cx="{pad_x + 36:.1f}" cy="{y1 + 36:.1f}" r="18" '
            f'fill="{acc_m["soft"]}" stroke="{acc_m["border"]}" stroke-width="1.2"/>'
        )
        body.append(
            _svg_text(
                pad_x + 36.0,
                y1 + 42.0,
                initial,
                font_size=15.0,
                fill=acc_m["text"],
                weight="700",
                anchor="middle",
            )
        )
        body.append(
            _svg_text(
                pad_x + 64.0, y1 + 34.0, name, font_size=16.5, fill=TEXT_PRIMARY, weight="700"
            )
        )
        role_bg = "#E0F2FE" if role == "组长" else BG_TRACK
        role_bd = "#BAE6FD" if role == "组长" else BORDER_LIGHT
        role_fg = "#0369A1" if role == "组长" else TEXT_MUTED
        role_pill, _ = _svg_pill(
            pad_x + 64.0 + _estimate_text_width(name, 16.5) + 10.0,
            y1 + 16.0,
            role,
            font_size=12.0,
            bg=role_bg,
            border=role_bd,
            fg=role_fg,
            weight="600",
            pad_x=9.0,
            height=22.0,
        )
        body.append(role_pill)
        if sub_lines:
            body.append(
                _svg_multiline_text(
                    pad_x + 64.0,
                    y1 + 58.0,
                    sub_lines,
                    font_size=13.0,
                    line_height=19.0,
                    fill=TEXT_MUTED,
                    weight="400",
                )
            )

        vals = member.get("values") if isinstance(member.get("values"), dict) else {}
        sy_start = y1 + (card_h - len(series) * 28.0) / 2.0 + 8.0
        for s_idx, ser in enumerate(series):
            skey = str(ser.get("key") or "")
            s_acc = _accent(ser.get("accent"), s_idx)
            s_lbl = str(ser.get("label") or skey)
            entry = vals.get(skey)
            raw_v = _safe_num(entry.get("value") if isinstance(entry, dict) else entry, 0.0)
            disp_lbl = str(entry.get("label") or raw_v) if isinstance(entry, dict) else f"{raw_v:g}"
            sy = sy_start + s_idx * 28.0

            body.append(
                _svg_text(right_x, sy + 11.0, s_lbl, font_size=13.0, fill=TEXT_MUTED, weight="500")
            )
            body.append(
                f'<rect x="{bar_x:.1f}" y="{sy:.1f}" width="{bar_w:.1f}" height="12" rx="6" fill="{BG_TRACK}"/>'
            )
            if raw_v > 0:
                fw = max(10.0, bar_w * min(1.0, raw_v / series_max[skey]))
                body.append(
                    f'<rect x="{bar_x:.1f}" y="{sy:.1f}" width="{fw:.1f}" height="12" rx="6" fill="{s_acc["main"]}"/>'
                )
            body.append(
                _svg_text(
                    pad_x + total_w - 16.0,
                    sy + 11.0,
                    disp_lbl,
                    font_size=13.0,
                    fill=TEXT_PRIMARY,
                    weight="700",
                    anchor="end",
                )
            )

        cursor_y += card_h + 12.0

    return _wrap_svg_document(CANVAS_WIDTH, cursor_y + 8.0, body, footer_text=payload.get("footer"))


# ── Fact-Grounded Default Visual Payload Builders ────────────────────────────


def _default_architecture_payload(facts: dict[str, Any]) -> dict[str, Any]:
    proj = facts.get("project") if isinstance(facts.get("project"), dict) else {}
    counts = facts.get("counts") if isinstance(facts.get("counts"), dict) else {}
    modules = facts.get("modules") if isinstance(facts.get("modules"), list) else []
    github = facts.get("github") if isinstance(facts.get("github"), dict) else {}
    feishu = facts.get("feishu") if isinstance(facts.get("feishu"), dict) else {}
    ev = facts.get("evidence") if isinstance(facts.get("evidence"), dict) else {}

    top_nodes = [
        {"title": "项目协作工作台", "subtitle": "需求基线 · 计划看板 · 任务树"},
        {
            "title": "多源证据中心",
            "subtitle": f"正式证据 {ev.get('total_formal', counts.get('evidence', 0))} 条",
        },
        {
            "title": "AI 核验与贡献核算",
            "subtitle": f"核验 {ev.get('verification_runs', 0)} 次 · 正式成果 {ev.get('formal_outcomes', 0)} 项",
        },
        {"title": "结项报告与导出", "subtitle": "Web 矢量画布 · PDF · Word DOCX"},
    ]

    mod_nodes: list[dict[str, Any]] = []
    for idx, mod in enumerate(modules[:8]):
        if not isinstance(mod, dict):
            continue
        t_tot = _safe_int(mod.get("tasks_total"), 0)
        t_done = _safe_int(mod.get("tasks_completed"), 0)
        pct = round(t_done * 100 / t_tot) if t_tot > 0 else 0
        samples = " · ".join(str(x) for x in (mod.get("sample_tasks") or [])[:2])
        owner = str(mod.get("owner") or "待指派")
        req_cnt = _safe_int(mod.get("requirements_count"), 0)
        sub_parts = [f"负责人：{owner} · 需求 {req_cnt} 条"]
        if samples:
            sub_parts.append(samples)
        mod_nodes.append(
            {
                "title": str(mod.get("name") or f"模块 {idx + 1}"),
                "subtitle": " | ".join(sub_parts),
                "metric": f"任务 {t_done}/{t_tot} ({pct}%)",
                "progress": pct,
                "accent": ACCENT_CYCLE[idx % 4],
            }
        )
    if not mod_nodes:
        t_tot = _safe_int(counts.get("tasks"), 0)
        t_done = _safe_int(counts.get("completed_tasks"), 0)
        pct = round(t_done * 100 / t_tot) if t_tot > 0 else 0
        mod_nodes.append(
            {
                "title": str(proj.get("name") or "核心业务系统"),
                "subtitle": f"需求 {proj.get('requirements_count', 0)} 条 · 成员 {counts.get('members', 0)} 人",
                "metric": f"任务完成 {t_done}/{t_tot} ({pct}%)",
                "progress": pct,
                "accent": "sky",
            }
        )

    infra_nodes = [
        {"title": "PostgreSQL", "subtitle": "业务与报告快照持久化"},
        {"title": "Redis + Celery", "subtitle": "异步任务与导出队列"},
        {
            "title": "GitHub 仓库集成",
            "subtitle": f"{github.get('repo_count', 0)} 仓库 · {github.get('commits', 0)} 提交 · {github.get('merged_prs', 0)} PR",
        },
        {
            "title": "飞书群聊协作",
            "subtitle": f"{feishu.get('chat_count', 0)} 群 · {feishu.get('total_messages', 0)} 消息 · {feishu.get('total_conclusions', 0)} 结论",
        },
        {
            "title": "OpenRouter AI",
            "subtitle": f"{ev.get('verification_runs', 0)} 次验收辅助 · 专业报告撰写与绘图",
        },
    ]

    return {
        "layers": [
            {"name": "前端交互与呈现层（Next.js App Router）", "accent": "sky", "nodes": top_nodes},
            {
                "name": f"核心业务模块与职责分工（共 {len(mod_nodes)} 个模块 · {proj.get('requirements_count', 0)} 条需求）",
                "accent": "emerald",
                "nodes": mod_nodes,
            },
            {"name": "外部集成与数据基础设施层", "accent": "violet", "nodes": infra_nodes},
        ]
    }


def _default_workflow_payload(facts: dict[str, Any]) -> dict[str, Any]:
    proj = facts.get("project") if isinstance(facts.get("project"), dict) else {}
    counts = facts.get("counts") if isinstance(facts.get("counts"), dict) else {}
    github = facts.get("github") if isinstance(facts.get("github"), dict) else {}
    feishu = facts.get("feishu") if isinstance(facts.get("feishu"), dict) else {}
    ev = facts.get("evidence") if isinstance(facts.get("evidence"), dict) else {}
    milestones = facts.get("milestones") if isinstance(facts.get("milestones"), list) else []

    t_tot = _safe_int(counts.get("tasks"), 0)
    t_done = _safe_int(counts.get("completed_tasks"), 0)
    comp_rate = round(t_done * 100 / t_tot) if t_tot else 0
    ev_tot = _safe_int(ev.get("total_formal", counts.get("evidence")), 0)
    ev_cov = round(_safe_int(ev.get("tasks_with_evidence"), 0) * 100 / t_tot) if t_tot else 0
    ms_done = sum(1 for m in milestones if isinstance(m, dict) and m.get("status") == "completed")
    pr_tot = _safe_int(github.get("pull_requests"), 0)
    pr_merged = _safe_int(github.get("merged_prs"), 0)
    ci_tot = _safe_int(github.get("ci_runs"), 0)
    ci_ok = _safe_int(github.get("ci_success"), 0)

    kpis = [
        {"label": "任务完成率", "value": f"{comp_rate}%"},
        {"label": "证据覆盖率", "value": f"{ev_cov}%"},
        {
            "label": "PR 合并率",
            "value": f"{round(pr_merged * 100 / pr_tot)}%" if pr_tot else "—",
        },
        {
            "label": "CI 通过率",
            "value": f"{round(ci_ok * 100 / ci_tot)}%"
            if ci_tot
            else f"{counts.get('risks', 0)} 风险",
        },
    ]

    return {
        "steps": [
            {
                "step": "01",
                "title": "需求基线冻结",
                "metric": f"{proj.get('requirements_count', 0)} 条需求",
                "detail": f"高优 {proj.get('requirements_high', 0)} 条 · 基线 v{proj.get('baseline_version') or '—'}",
                "accent": "sky",
            },
            {
                "step": "02",
                "title": "任务规划分工",
                "metric": f"{t_tot} 项任务",
                "detail": f"{proj.get('modules_count', 0)} 个模块 · {counts.get('members', 0)} 名成员",
                "accent": "indigo",
            },
            {
                "step": "03",
                "title": "GitHub / 飞书协作",
                "metric": f"{github.get('commits', 0)} 提交 / {feishu.get('total_messages', 0)} 消息",
                "detail": f"{pr_merged} 合并 PR · {feishu.get('total_conclusions', 0)} 协作结论",
                "accent": "violet",
            },
            {
                "step": "04",
                "title": "正式证据采纳",
                "metric": f"{ev_tot} 条正式证据",
                "detail": f"覆盖 {ev.get('tasks_with_evidence', 0)}/{t_tot} 任务 ({ev_cov}%)",
                "accent": "amber",
            },
            {
                "step": "05",
                "title": "AI 核验 + 人工确认",
                "metric": f"{ev.get('criteria_total', 0)} 条标准",
                "detail": f"{ev.get('verification_runs', 0)} 次核验 · {ev.get('formal_outcomes', 0)} 项正式成果",
                "accent": "emerald",
            },
            {
                "step": "06",
                "title": "贡献核算与结项",
                "metric": f"{comp_rate}% 完成",
                "detail": f"里程碑 {ms_done}/{len(milestones)} · 报告归档",
                "accent": "teal",
            },
        ],
        "kpis": kpis,
        "footer_note": "过程核验机制：代码与交付产物变更可触发证据追溯校验，AI 辅助验收后由责任人人工确认生效。",
    }


def _default_milestones_payload(facts: dict[str, Any]) -> dict[str, Any]:
    counts = facts.get("counts") if isinstance(facts.get("counts"), dict) else {}
    milestones = facts.get("milestones") if isinstance(facts.get("milestones"), list) else []
    modules = facts.get("modules") if isinstance(facts.get("modules"), list) else []

    t_tot = _safe_int(counts.get("tasks"), 0)
    t_done = _safe_int(counts.get("completed_tasks"), 0)
    comp_rate = round(t_done * 100 / t_tot) if t_tot else 0

    items: list[dict[str, Any]] = []
    if milestones:
        ms_done = sum(
            1 for m in milestones if isinstance(m, dict) and m.get("status") == "completed"
        )
        d_done = sum(
            _safe_int(m.get("deliverables_done"), 0) for m in milestones if isinstance(m, dict)
        )
        d_tot = sum(
            _safe_int(m.get("deliverables_total"), 0) for m in milestones if isinstance(m, dict)
        )
        for ms in milestones[:10]:
            if not isinstance(ms, dict):
                continue
            status = str(ms.get("status") or "")
            tone = (
                "emerald"
                if status == "completed"
                else (
                    "amber"
                    if status == "at_risk"
                    else ("sky" if status == "in_progress" else "slate")
                )
            )
            meta_parts: list[str] = []
            if _safe_int(ms.get("deliverables_total"), 0) > 0:
                meta_parts.append(
                    f"交付物 {ms.get('deliverables_done', 0)}/{ms.get('deliverables_total', 0)}"
                )
            if _safe_int(ms.get("linked_tasks_total"), 0) > 0:
                meta_parts.append(
                    f"任务 {ms.get('linked_tasks_completed', 0)}/{ms.get('linked_tasks_total', 0)}"
                )
            items.append(
                {
                    "label": str(ms.get("title") or "阶段里程碑"),
                    "date": str(ms.get("deadline") or ""),
                    "progress": _safe_int(ms.get("progress_percent"), 0),
                    "status": str(ms.get("status_label") or status or "进行中"),
                    "tone": tone,
                    "meta": " · ".join(meta_parts),
                }
            )
        summary_badges = [
            {"label": "里程碑达成", "value": f"{ms_done}/{len(milestones)}", "accent": "emerald"},
            {"label": "交付物核验", "value": f"{d_done}/{d_tot}", "accent": "sky"},
            {
                "label": "任务总进度",
                "value": f"{t_done}/{t_tot} ({comp_rate}%)",
                "accent": "violet",
            },
        ]
    else:
        for mod in modules[:8]:
            if not isinstance(mod, dict):
                continue
            mt = _safe_int(mod.get("tasks_total"), 0)
            md = _safe_int(mod.get("tasks_completed"), 0)
            pct = round(md * 100 / mt) if mt else 0
            items.append(
                {
                    "label": str(mod.get("name") or "功能模块"),
                    "date": "",
                    "progress": pct,
                    "status": "已完成" if pct >= 100 else "进行中",
                    "tone": "emerald" if pct >= 100 else "sky",
                    "meta": f"负责人 {mod.get('owner', '—')} · 任务 {md}/{mt}",
                }
            )
        summary_badges = [
            {"label": "功能模块", "value": f"{len(modules)} 个", "accent": "sky"},
            {
                "label": "任务总进度",
                "value": f"{t_done}/{t_tot} ({comp_rate}%)",
                "accent": "emerald",
            },
        ]

    return {"summary_badges": summary_badges, "items": items}


def _default_evidence_payload(facts: dict[str, Any]) -> dict[str, Any]:
    counts = facts.get("counts") if isinstance(facts.get("counts"), dict) else {}
    ev = facts.get("evidence") if isinstance(facts.get("evidence"), dict) else {}
    feishu = facts.get("feishu") if isinstance(facts.get("feishu"), dict) else {}
    t_tot = _safe_int(counts.get("tasks"), 0)
    ev_cov = round(_safe_int(ev.get("tasks_with_evidence"), 0) * 100 / t_tot) if t_tot else 0

    by_source = ev.get("by_source") if isinstance(ev.get("by_source"), dict) else {}
    ev_items = [
        {
            "label": _EVIDENCE_SOURCE_ZH.get(str(src), str(src)),
            "value": _safe_int(cnt, 0),
            "unit": " 条",
            "accent": ACCENT_CYCLE[idx % len(ACCENT_CYCLE)],
        }
        for idx, (src, cnt) in enumerate(
            sorted(by_source.items(), key=lambda kv: -_safe_int(kv[1]))
        )
        if _safe_int(cnt, 0) > 0
    ]

    categories = feishu.get("categories") if isinstance(feishu.get("categories"), dict) else {}
    feishu_items = [
        {
            "label": _FEISHU_CATEGORY_ZH.get(str(cat), str(cat)),
            "value": _safe_int(cnt, 0),
            "unit": " 项",
            "accent": ACCENT_CYCLE[(idx + 2) % len(ACCENT_CYCLE)],
        }
        for idx, (cat, cnt) in enumerate(
            sorted(categories.items(), key=lambda kv: -_safe_int(kv[1]))
        )
        if _safe_int(cnt, 0) > 0
    ]

    left_panel = {
        "title": "正式证据来源分布",
        "accent": "sky",
        "total_label": f"共 {ev.get('total_formal', 0)} 条 · 覆盖 {ev_cov}%",
        "items": ev_items,
        "empty_message": "当前尚未归档正式证据记录",
        "footnote": (
            f"验收标准 {ev.get('criteria_total', 0)} 条 · "
            f"核验运行 {ev.get('verification_runs', 0)} 次 · "
            f"正式成果 {ev.get('formal_outcomes', 0)} 项"
        ),
    }

    right_panel = {
        "title": "飞书 AI 协作结论结构",
        "accent": "violet",
        "total_label": f"共 {feishu.get('total_conclusions', 0)} 项 · {feishu.get('total_messages', 0)} 消息",
        "items": feishu_items,
        "empty_message": "当前项目暂未接入飞书群聊协作摘要",
        "footnote": (
            f"群聊覆盖时段：{feishu.get('date_range')}"
            if feishu.get("date_range")
            else f"绑定飞书工作群 {feishu.get('chat_count', 0)} 个"
        ),
    }
    return {"panels": [left_panel, right_panel]}


def _default_contribution_payload(facts: dict[str, Any]) -> dict[str, Any]:
    members = facts.get("members") if isinstance(facts.get("members"), list) else []
    has_feishu_member = any(
        _safe_int(m.get("feishu_collab_count"), 0) > 0 for m in members if isinstance(m, dict)
    )
    has_ev_member = any(
        _safe_int(m.get("evidence_authored"), 0) > 0 for m in members if isinstance(m, dict)
    )

    fourth_label = (
        "飞书协作参与"
        if has_feishu_member
        else ("正式证据贡献" if has_ev_member else "GitHub PR 参与")
    )
    series = [
        {"key": "share", "label": "正式贡献权重 (%)", "accent": "sky"},
        {"key": "tasks", "label": "任务完成数", "accent": "emerald"},
        {"key": "commits", "label": "GitHub 代码提交", "accent": "violet"},
        {"key": "collab", "label": fourth_label, "accent": "amber"},
    ]

    rows: list[dict[str, Any]] = []
    for m in members[:8]:
        if not isinstance(m, dict):
            continue
        share = round(_safe_num(m.get("share_percent"), 0.0), 1)
        t_done = _safe_int(m.get("tasks_completed"), 0)
        t_tot = _safe_int(m.get("tasks_assigned"), 0)
        commits = _safe_int(m.get("github_commits"), 0)
        prs = _safe_int(m.get("github_prs"), 0)
        feishu_cnt = _safe_int(m.get("feishu_collab_count"), 0)
        ev_cnt = _safe_int(m.get("evidence_authored"), 0)

        if has_feishu_member:
            fourth_val = feishu_cnt
            fourth_txt = f"{feishu_cnt} 项协作"
        elif has_ev_member:
            fourth_val = ev_cnt
            fourth_txt = f"{ev_cnt} 条证据"
        else:
            fourth_val = prs
            fourth_txt = f"{prs} 个 PR"

        mods = m.get("owned_modules") if isinstance(m.get("owned_modules"), list) else []
        rows.append(
            {
                "name": str(m.get("name") or "成员"),
                "role": str(m.get("role") or "成员"),
                "subtitle": "、".join(str(x) for x in mods[:2]) or "跨模块协作支持",
                "values": {
                    "share": {"value": share, "label": f"{share:.1f}%"},
                    "tasks": {"value": t_done, "label": f"{t_done}/{t_tot} 项"},
                    "commits": {
                        "value": commits,
                        "label": f"{commits} 次 ({prs} PR)" if prs else f"{commits} 次",
                    },
                    "collab": {"value": fourth_val, "label": fourth_txt},
                },
            }
        )

    return {"series": series, "members": rows}


def _default_payload_for_template(template: str, facts: dict[str, Any]) -> dict[str, Any]:
    if template == "layered_architecture":
        return _default_architecture_payload(facts)
    if template == "process_flow":
        return _default_workflow_payload(facts)
    if template == "milestone_timeline":
        return _default_milestones_payload(facts)
    if template == "category_breakdown":
        return _default_evidence_payload(facts)
    if template == "member_comparison":
        return _default_contribution_payload(facts)
    return _default_architecture_payload(facts)


def build_default_visual_specs(facts: dict[str, Any]) -> list[dict[str, Any]]:
    """Build fact-grounded fallback visual specs tailored to the available project data."""
    proj_name = str((facts.get("project") or {}).get("name") or "项目")
    return [
        {
            "id": "architecture",
            "section_key": "overview",
            "template": "layered_architecture",
            "badge": "系统架构",
            "title": "系统架构与模块分工总览图",
            "subtitle": f"{proj_name} · 分层结构与模块职责边界",
            "caption": "图 1：系统架构与模块分工总览图",
            "payload": _default_architecture_payload(facts),
        },
        {
            "id": "workflow",
            "section_key": "workflow",
            "template": "process_flow",
            "badge": "研发流程",
            "title": "证据驱动的研发协作与验收流程图",
            "subtitle": f"{proj_name} · 从需求基线到结项归档的六阶段协同",
            "caption": "图 2：证据驱动的研发协作与验收流程图",
            "payload": _default_workflow_payload(facts),
        },
        {
            "id": "milestones",
            "section_key": "progress",
            "template": "milestone_timeline",
            "badge": "阶段进度",
            "title": "阶段里程碑推进与任务完成进度图",
            "subtitle": f"{proj_name} · 阶段节点达成与交付物核验",
            "caption": "图 3：阶段里程碑推进与任务完成进度图",
            "payload": _default_milestones_payload(facts),
        },
        {
            "id": "evidence",
            "section_key": "evidence",
            "template": "category_breakdown",
            "badge": "证据与协作",
            "title": "正式证据来源分布与飞书协作结论结构图",
            "subtitle": f"{proj_name} · 多源工程产物与协作结论交叉印证",
            "caption": "图 4：正式证据来源分布与飞书协作结论结构图",
            "payload": _default_evidence_payload(facts),
        },
        {
            "id": "contribution",
            "section_key": "contribution",
            "template": "member_comparison",
            "badge": "成员贡献",
            "title": "团队成员多维贡献与分工对比图",
            "subtitle": f"{proj_name} · 权重、任务、代码与协作多维画像",
            "caption": "图 5：团队成员多维贡献与分工对比图",
            "payload": _default_contribution_payload(facts),
        },
    ]


# ── Sanitization & Validation for AI-Authored Visual Specs ────────────────────


def sanitize_visual_specs(raw_visuals: Any, facts: dict[str, Any]) -> list[dict[str, Any]]:
    """Validate and normalize AI-proposed visual specs (including `custom_svg` with safe fallback)."""
    if not isinstance(raw_visuals, list):
        return []
    section_order_rank = {k: i for i, k in enumerate(VALID_SECTION_KEYS)}
    seen_ids: set[str] = set()
    cleaned: list[dict[str, Any]] = []

    for idx, item in enumerate(raw_visuals[:6]):
        if not isinstance(item, dict):
            continue
        template = str(item.get("template") or "").strip()
        if template not in VISUAL_TEMPLATES:
            continue
        section_key = str(item.get("section_key") or "").strip()
        if section_key not in section_order_rank:
            continue

        raw_id = re.sub(r"[^a-z0-9_-]+", "_", str(item.get("id") or "").strip().lower()).strip("_-")
        if not raw_id:
            raw_id = f"{section_key}_{idx + 1}"
        raw_id = raw_id[:44]
        candidate_id = raw_id
        suffix = 2
        while candidate_id in seen_ids or not CHART_KEY_RE.match(candidate_id):
            candidate_id = f"{raw_id[:40]}_{suffix}"
            suffix += 1
        seen_ids.add(candidate_id)

        title = str(item.get("title") or "").strip()[:80]
        if not title:
            continue
        subtitle = str(item.get("subtitle") or "").strip()[:120]
        badge = str(item.get("badge") or "").strip()[:16]
        raw_caption = str(item.get("caption") or title).strip()[:120]
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}

        if template == "custom_svg":
            raw_svg = payload.get("svg") or item.get("svg")
            clean_svg = sanitize_custom_svg(raw_svg)
            fb_tpl = str(item.get("fallback_template") or "").strip()
            if fb_tpl not in TEMPLATE_ONLY_VISUALS:
                fb_tpl = SECTION_DEFAULT_TEMPLATE.get(section_key, "layered_architecture")
            if clean_svg is not None:
                cleaned.append(
                    {
                        "id": candidate_id,
                        "section_key": section_key,
                        "template": "custom_svg",
                        "fallback_template": fb_tpl,
                        "badge": badge,
                        "title": title,
                        "subtitle": subtitle,
                        "caption": raw_caption,
                        "payload": {"svg": clean_svg},
                    }
                )
            else:
                logger.warning(
                    "custom_svg visual %s failed security/XML validation; degrading to %s",
                    candidate_id,
                    fb_tpl,
                )
                cleaned.append(
                    {
                        "id": candidate_id,
                        "section_key": section_key,
                        "template": fb_tpl,
                        "degraded_from": "custom_svg",
                        "badge": badge,
                        "title": title,
                        "subtitle": subtitle,
                        "caption": raw_caption,
                        "payload": _default_payload_for_template(fb_tpl, facts),
                    }
                )
            continue

        # Verify template payload has usable data (or gracefully hydrate from facts if empty)
        if template == "layered_architecture" and not (
            isinstance(payload.get("layers"), list) and len(payload["layers"]) >= 2
        ):
            payload = _default_architecture_payload(facts)
        elif template == "process_flow" and not (
            isinstance(payload.get("steps"), list) and len(payload["steps"]) >= 3
        ):
            payload = _default_workflow_payload(facts)
        elif template == "milestone_timeline" and not (
            isinstance(payload.get("items"), list) and len(payload["items"]) >= 1
        ):
            payload = _default_milestones_payload(facts)
        elif template == "category_breakdown" and not (
            isinstance(payload.get("panels"), list) and len(payload["panels"]) >= 1
        ):
            payload = _default_evidence_payload(facts)
        elif template == "member_comparison" and not (
            isinstance(payload.get("members"), list)
            and len(payload["members"]) >= 1
            and isinstance(payload.get("series"), list)
            and len(payload["series"]) >= 1
        ):
            payload = _default_contribution_payload(facts)

        cleaned.append(
            {
                "id": candidate_id,
                "section_key": section_key,
                "template": template,
                "badge": badge,
                "title": title,
                "subtitle": subtitle,
                "caption": raw_caption,
                "payload": payload,
            }
        )

    cleaned.sort(key=lambda sp: section_order_rank.get(sp["section_key"], 99))
    for fig_no, sp in enumerate(cleaned, start=1):
        cap = re.sub(r"^图\s*\d+\s*[：:]\s*", "", sp["caption"]).strip() or sp["title"]
        sp["caption"] = f"图 {fig_no}：{cap}"
    return cleaned


# ── Unified SVG Rendering & 2.5x Ultra-HD PNG Rasterization ───────────────────

_SVG_TEMPLATE_RENDERERS = {
    "layered_architecture": _render_layered_architecture_svg,
    "process_flow": _render_process_flow_svg,
    "milestone_timeline": _render_milestone_timeline_svg,
    "category_breakdown": _render_category_breakdown_svg,
    "member_comparison": _render_member_comparison_svg,
}


def render_visual_spec_svg(spec: dict[str, Any], facts: dict[str, Any] | None = None) -> str:
    """Render any single visual spec into a clean, self-contained pure-vector SVG string."""
    template = str(spec.get("template") or "")
    if template == "custom_svg":
        payload = spec.get("payload") if isinstance(spec.get("payload"), dict) else {}
        clean_svg = sanitize_custom_svg(payload.get("svg"))
        if clean_svg is not None:
            return clean_svg
        fb_tpl = str(spec.get("fallback_template") or "").strip()
        if fb_tpl not in TEMPLATE_ONLY_VISUALS:
            fb_tpl = SECTION_DEFAULT_TEMPLATE.get(
                str(spec.get("section_key") or ""), "layered_architecture"
            )
        fallback_spec = {
            **spec,
            "template": fb_tpl,
            "payload": _default_payload_for_template(fb_tpl, facts or {}),
        }
        return _SVG_TEMPLATE_RENDERERS[fb_tpl](fallback_spec, facts or {})

    renderer = _SVG_TEMPLATE_RENDERERS.get(template)
    if renderer is None:
        raise ValueError(f"Unsupported visual template: {template}")
    return renderer(spec, facts or {})


def _try_cairosvg_png(svg_bytes: bytes, scale: float) -> bytes | None:
    try:
        # Help macOS Homebrew libcairo discovery when DYLD_FALLBACK_LIBRARY_PATH is unset
        if os.name == "posix" and os.path.isdir("/opt/homebrew/lib"):
            cur = os.environ.get("DYLD_FALLBACK_LIBRARY_PATH", "")
            if "/opt/homebrew/lib" not in cur:
                os.environ["DYLD_FALLBACK_LIBRARY_PATH"] = (
                    f"/opt/homebrew/lib:{cur}" if cur else "/opt/homebrew/lib"
                )
        import cairosvg  # type: ignore[import-untyped]

        return bytes(cairosvg.svg2png(bytestring=svg_bytes, scale=scale))
    except Exception:
        return None


def _try_rsvg_convert_png(svg_bytes: bytes, scale: float) -> bytes | None:
    exe = shutil.which("rsvg-convert")
    if not exe:
        return None
    try:
        proc = subprocess.run(
            [exe, "-z", f"{scale:g}", "-f", "png"],
            input=svg_bytes,
            capture_output=True,
            check=True,
            timeout=15,
        )
        if proc.stdout.startswith(b"\x89PNG\r\n\x1a\n"):
            return proc.stdout
    except Exception:
        return None
    return None


def _fallback_pillow_svg_png(svg_str: str, scale: float) -> bytes:
    """Minimal pure-Python Pillow raster fallback used ONLY when libcairo/rsvg are absent locally."""
    from PIL import Image, ImageDraw, ImageFont

    vw, vh = float(CANVAS_WIDTH), 620.0
    try:
        root = ET.fromstring(svg_str)
        parsed_vb = _parse_viewbox(root.attrib.get("viewBox", ""))
        if parsed_vb is not None:
            _, _, vw, vh = parsed_vb
    except ET.ParseError:
        root = None

    px_w = max(800, int(round(vw * scale)))
    px_h = max(450, int(round(vh * scale)))
    img = Image.new("RGB", (px_w, px_h), BG_WHITE)
    draw = ImageDraw.Draw(img)

    # Pick a crisp system CJK font if available (never use fake bold stroke_width=1)
    font_cache: dict[int, Any] = {}
    font_candidates = (
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
    )
    resolved_font = next((p for p in font_candidates if os.path.isfile(p)), None)

    def _font(sz: float) -> Any:
        isz = max(12, int(round(sz * scale)))
        if isz not in font_cache:
            if resolved_font:
                try:
                    font_cache[isz] = ImageFont.truetype(resolved_font, size=isz, index=0)
                except OSError:
                    font_cache[isz] = ImageFont.load_default()
            else:
                font_cache[isz] = ImageFont.load_default()
        return font_cache[isz]

    if root is not None:
        for el in root.iter():
            tag = _local_name(el.tag).lower()
            if tag == "rect":
                x = _safe_num(el.attrib.get("x"), 0.0) * scale
                y = _safe_num(el.attrib.get("y"), 0.0) * scale
                w = _safe_num(el.attrib.get("width"), 0.0) * scale
                h = _safe_num(el.attrib.get("height"), 0.0) * scale
                rx = _safe_num(el.attrib.get("rx"), 0.0) * scale
                fill = el.attrib.get("fill")
                stroke = el.attrib.get("stroke")
                sw = max(1, int(round(_safe_num(el.attrib.get("stroke-width"), 1.0) * scale)))
                if w > 0 and h > 0:
                    draw.rounded_rectangle(
                        [x, y, x + w, y + h],
                        radius=min(rx, w / 2, h / 2),
                        fill=fill if fill and fill.startswith("#") else None,
                        outline=stroke if stroke and stroke.startswith("#") else None,
                        width=sw if stroke and stroke.startswith("#") else 0,
                    )
            elif tag == "line":
                x1 = _safe_num(el.attrib.get("x1"), 0.0) * scale
                y1 = _safe_num(el.attrib.get("y1"), 0.0) * scale
                x2 = _safe_num(el.attrib.get("x2"), 0.0) * scale
                y2 = _safe_num(el.attrib.get("y2"), 0.0) * scale
                stroke = el.attrib.get("stroke")
                sw = max(1, int(round(_safe_num(el.attrib.get("stroke-width"), 1.0) * scale)))
                if stroke and stroke.startswith("#"):
                    draw.line([(x1, y1), (x2, y2)], fill=stroke, width=sw)
            elif tag == "circle":
                cx = _safe_num(el.attrib.get("cx"), 0.0) * scale
                cy = _safe_num(el.attrib.get("cy"), 0.0) * scale
                r = _safe_num(el.attrib.get("r"), 0.0) * scale
                fill = el.attrib.get("fill")
                stroke = el.attrib.get("stroke")
                if r > 0:
                    draw.ellipse(
                        [cx - r, cy - r, cx + r, cy + r],
                        fill=fill if fill and fill.startswith("#") else None,
                        outline=stroke if stroke and stroke.startswith("#") else None,
                        width=max(1, int(round(scale))),
                    )
            elif tag == "text":
                tx = _safe_num(el.attrib.get("x"), 0.0) * scale
                ty = _safe_num(el.attrib.get("y"), 0.0) * scale
                fs = _safe_num(el.attrib.get("font-size"), 14.0)
                fill = el.attrib.get("fill") or TEXT_PRIMARY
                if not fill.startswith("#"):
                    fill = TEXT_PRIMARY
                anchor_attr = el.attrib.get("text-anchor", "start")
                pil_anchor = {"middle": "ms", "end": "rs"}.get(anchor_attr, "ls")
                fnt = _font(fs)
                children = list(el)
                if children:
                    cur_y = ty
                    for ch in children:
                        if _local_name(ch.tag).lower() == "tspan" and ch.text:
                            cx = (
                                _safe_num(ch.attrib.get("x"), tx / scale) * scale
                                if "x" in ch.attrib
                                else tx
                            )
                            cur_y += _safe_num(ch.attrib.get("dy"), 0.0) * scale
                            draw.text((cx, cur_y), ch.text, font=fnt, fill=fill, anchor=pil_anchor)
                elif el.text:
                    draw.text((tx, ty), el.text, font=fnt, fill=fill, anchor=pil_anchor)

    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def svg_to_png(svg_str: str, *, scale: float = PNG_RASTER_SCALE) -> bytes:
    """Rasterize a clean vector SVG into an ultra-HD PNG (default 2.5x -> ~3000px wide)."""
    svg_bytes = svg_str.encode("utf-8")
    png = _try_cairosvg_png(svg_bytes, scale)
    if png is not None:
        return png
    png = _try_rsvg_convert_png(svg_bytes, scale)
    if png is not None:
        return png
    logger.warning("CairoSVG and rsvg-convert unavailable; using Pillow vector fallback")
    return _fallback_pillow_svg_png(svg_str, scale)


def render_visual_spec(
    spec: dict[str, Any], facts: dict[str, Any] | None = None, *, scale: float = PNG_RASTER_SCALE
) -> bytes:
    """Render any single declarative visual spec into crisp 2.5x ultra-HD PNG bytes."""
    svg_str = render_visual_spec_svg(spec, facts)
    return svg_to_png(svg_str, scale=scale)


def find_visual_spec(
    data_snapshot: dict[str, Any], chart_key: str, *, fallback_facts: dict[str, Any] | None = None
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Locate a visual spec in `data_snapshot['visuals']` or synthesize for legacy keys."""
    if not CHART_KEY_RE.match(chart_key):
        return None, {}
    facts = (
        data_snapshot.get("facts")
        if isinstance(data_snapshot.get("facts"), dict)
        else (fallback_facts or {})
    )
    visuals = data_snapshot.get("visuals")
    if isinstance(visuals, list):
        for spec in visuals:
            if isinstance(spec, dict) and str(spec.get("id") or "") == chart_key:
                return spec, facts

    if chart_key in ALLOWED_DEFAULT_CHART_KEYS and facts:
        for default_spec in build_default_visual_specs(facts):
            if default_spec["id"] == chart_key:
                return default_spec, facts
    return None, facts


def render_chart_svg_from_snapshot(
    data_snapshot: dict[str, Any],
    chart_key: str,
    *,
    fallback_facts: dict[str, Any] | None = None,
) -> str | None:
    """Render a pure-vector SVG string from a report snapshot's `visuals` / `facts`."""
    spec, facts = find_visual_spec(data_snapshot, chart_key, fallback_facts=fallback_facts)
    if spec is None:
        return None
    return render_visual_spec_svg(spec, facts)


def render_chart_from_snapshot(
    data_snapshot: dict[str, Any],
    chart_key: str,
    *,
    fallback_facts: dict[str, Any] | None = None,
    scale: float = PNG_RASTER_SCALE,
) -> bytes | None:
    """Render a 2.5x ultra-HD PNG from a report snapshot's `visuals` / `facts`."""
    svg_str = render_chart_svg_from_snapshot(
        data_snapshot, chart_key, fallback_facts=fallback_facts
    )
    if svg_str is None:
        return None
    return svg_to_png(svg_str, scale=scale)
