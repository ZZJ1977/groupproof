# ruff: noqa: E501
"""High-DPI CJK publication-grade diagram & chart renderer for D4 closing reports.

Supports declarative AI-authored visual specs stored in `ReportSnapshot.data_snapshot["visuals"]`
across 5 general-purpose layout templates:
  - `layered_architecture`: multi-layer architecture & module ownership diagram
  - `process_flow`: horizontal multi-stage engineering/workflow pipeline diagram
  - `milestone_timeline`: chronological progress bar chart with dates, status pills & deliverables
  - `category_breakdown`: 1-panel or 2-panel ranked distribution horizontal bar chart
  - `member_comparison`: multi-dimensional grouped horizontal bar chart across team members

Also synthesizes fact-grounded default visual specs whenever AI visual planning is unavailable
or omitted, and renders crisp 2x Retina PNGs using Pillow with automatic CJK font discovery
across Linux Docker (WenQuanYi Zen Hei / Noto Sans CJK) and macOS (Noto Sans CJK / PingFang / Heiti).
"""

from __future__ import annotations

import os
import re
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

# ── Public contracts & registries ─────────────────────────────────────────────

VISUAL_TEMPLATES: frozenset[str] = frozenset(
    {
        "layered_architecture",
        "process_flow",
        "milestone_timeline",
        "category_breakdown",
        "member_comparison",
    }
)

VALID_SECTION_KEYS: tuple[str, ...] = (
    "overview",
    "workflow",
    "progress",
    "collaboration",
    "evidence",
    "contribution",
    "reflection",
)

CHART_KEY_RE = re.compile(r"^[a-z0-9_-]{1,48}$")

# Legacy / default fallback chart keys (also supported when rendering snapshots without visuals[])
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

# ── Academic-clean design tokens ──────────────────────────────────────────────

CANVAS_WIDTH = 1400
BG_WHITE = "#ffffff"
BG_SUBTLE = "#f8fafc"
BG_TRACK = "#f1f5f9"
BORDER_LIGHT = "#e2e8f0"
BORDER_MED = "#cbd5e1"
TEXT_PRIMARY = "#0f172a"
TEXT_SECONDARY = "#334155"
TEXT_MUTED = "#64748b"
TEXT_LIGHT = "#94a3b8"

ACCENT_TOKENS: dict[str, dict[str, str]] = {
    "sky": {"main": "#0284c7", "soft": "#e0f2fe", "border": "#bae6fd", "text": "#0369a1"},
    "emerald": {"main": "#059669", "soft": "#d1fae5", "border": "#a7f3d0", "text": "#047857"},
    "violet": {"main": "#7c3aed", "soft": "#ede9fe", "border": "#ddd6fe", "text": "#6d28d9"},
    "amber": {"main": "#d97706", "soft": "#fef3c7", "border": "#fde68a", "text": "#b45309"},
    "rose": {"main": "#e11d48", "soft": "#ffe4e6", "border": "#fecdd3", "text": "#be123c"},
    "indigo": {"main": "#4f46e5", "soft": "#e0e7ff", "border": "#c7d2fe", "text": "#4338ca"},
    "teal": {"main": "#0d9488", "soft": "#ccfbf1", "border": "#99f6e4", "text": "#0f766e"},
    "slate": {"main": "#475569", "soft": "#f1f5f9", "border": "#cbd5e1", "text": "#334155"},
}
ACCENT_CYCLE: tuple[str, ...] = ("sky", "emerald", "violet", "amber", "indigo", "teal", "rose")


def _accent(name: str | None, fallback_idx: int = 0) -> dict[str, str]:
    key = (name or "").strip().lower()
    if key in ACCENT_TOKENS:
        return ACCENT_TOKENS[key]
    return ACCENT_TOKENS[ACCENT_CYCLE[fallback_idx % len(ACCENT_CYCLE)]]


# ── Automatic CJK Font Discovery ──────────────────────────────────────────────

_REGULAR_FONT_CANDIDATES: tuple[tuple[str, int], ...] = (
    # Linux Railway Docker (WenQuanYi Zen Hei & Noto Sans CJK)
    ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
    ("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", 0),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 2),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
    ("/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf", 0),
    ("/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", 0),
    ("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", 0),
    ("/usr/share/fonts/truetype/arphic/uming.ttc", 0),
    # macOS local dev / CI
    ("/Library/Fonts/NotoSansCJKsc-Regular.otf", 0),
    ("/System/Library/Fonts/PingFang.ttc", 0),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0),
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0),
    ("/System/Library/Fonts/STHeiti Light.ttc", 0),
    ("/System/Library/Fonts/Supplemental/Songti.ttc", 0),
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0),
)

_BOLD_FONT_CANDIDATES: tuple[tuple[str, int], ...] = (
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 2),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 0),
    ("/usr/share/fonts/opentype/noto/NotoSansCJKsc-Bold.otf", 0),
    ("/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc", 0),
    ("/Library/Fonts/NotoSansCJKsc-Bold.otf", 0),
    ("/System/Library/Fonts/PingFang.ttc", 2),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 1),
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0),
)


@lru_cache(maxsize=2)
def _discover_cjk_font(bold: bool = False) -> tuple[str | None, int]:
    env_override = os.getenv("REPORT_CJK_FONT_PATH", "").strip()
    if env_override and Path(env_override).is_file():
        return env_override, 0

    candidates = (
        (*_BOLD_FONT_CANDIDATES, *_REGULAR_FONT_CANDIDATES) if bold else _REGULAR_FONT_CANDIDATES
    )
    for path_str, index in candidates:
        if Path(path_str).is_file():
            try:
                ImageFont.truetype(path_str, size=20, index=index)
                return path_str, index
            except OSError:
                continue

    # Dynamic fallback scan on Linux font directories
    for root in (Path("/usr/share/fonts"), Path("/usr/local/share/fonts")):
        if not root.is_dir():
            continue
        for ext in ("*.ttc", "*.otf", "*.ttf"):
            for found in sorted(root.rglob(ext)):
                low = found.name.lower()
                if any(tok in low for tok in ("cjk", "wqy", "zenhei", "microhei", "han", "hei")):
                    try:
                        ImageFont.truetype(str(found), size=20, index=0)
                        return str(found), 0
                    except OSError:
                        continue
    return None, 0


@lru_cache(maxsize=48)
def _get_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    path_str, index = _discover_cjk_font(bold=bold)
    if path_str is not None:
        try:
            return ImageFont.truetype(path_str, size=size, index=index)
        except OSError:
            pass
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def _needs_fake_bold() -> bool:
    reg = _discover_cjk_font(bold=False)
    bld = _discover_cjk_font(bold=True)
    return reg[0] is not None and reg == bld


# ── Low-level drawing helpers ─────────────────────────────────────────────────


def _text_width(font: Any, text: str) -> float:
    try:
        return float(font.getlength(text))
    except Exception:
        bbox = font.getbbox(text)
        return float(bbox[2] - bbox[0]) if bbox else float(len(text) * 12)


def _truncate(text: str, font: Any, max_width: float) -> str:
    clean = " ".join(str(text or "").split())
    if not clean or _text_width(font, clean) <= max_width:
        return clean
    ellipsis = "…"
    budget = max_width - _text_width(font, ellipsis)
    if budget <= 0:
        return ellipsis
    lo, hi = 0, len(clean)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if _text_width(font, clean[:mid]) <= budget:
            lo = mid
        else:
            hi = mid - 1
    return clean[:lo].rstrip() + ellipsis


def _wrap_lines(text: str, font: Any, max_width: float, max_lines: int = 2) -> list[str]:
    clean = " ".join(str(text or "").split())
    if not clean:
        return []
    lines: list[str] = []
    remaining = clean
    while remaining and len(lines) < max_lines:
        if _text_width(font, remaining) <= max_width:
            lines.append(remaining)
            remaining = ""
            break
        if len(lines) == max_lines - 1:
            lines.append(_truncate(remaining, font, max_width))
            remaining = ""
            break
        lo, hi = 1, len(remaining)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if _text_width(font, remaining[:mid]) <= max_width:
                lo = mid
            else:
                hi = mid - 1
        split_at = lo
        # Avoid splitting an ASCII word/token right in the middle (e.g., "P" / "R")
        if (
            split_at < len(remaining)
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
        lines.append(remaining[:split_at].rstrip())
        remaining = remaining[split_at:].lstrip()
    return lines


def _draw_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[float, float],
    text: str,
    *,
    font: Any,
    fill: str,
    bold: bool = False,
    anchor: str | None = None,
) -> None:
    kwargs: dict[str, Any] = {"font": font, "fill": fill}
    if anchor:
        kwargs["anchor"] = anchor
    if bold and _needs_fake_bold():
        kwargs["stroke_width"] = 1
        kwargs["stroke_fill"] = fill
    draw.text(xy, str(text), **kwargs)


def _draw_pill(
    draw: ImageDraw.ImageDraw,
    x: float,
    y: float,
    text: str,
    *,
    font: Any,
    bg: str,
    border: str,
    fg: str,
    pad_x: int = 12,
    height: int = 28,
    max_width: float | None = None,
) -> float:
    label = _truncate(text, font, (max_width - pad_x * 2) if max_width else 600)
    w = _text_width(font, label) + pad_x * 2
    draw.rounded_rectangle(
        [x, y, x + w, y + height],
        radius=height // 2,
        fill=bg,
        outline=border,
        width=1,
    )
    _draw_text(draw, (x + w / 2, y + height / 2), label, font=font, fill=fg, anchor="mm")
    return w


def _draw_down_arrow(
    draw: ImageDraw.ImageDraw, cx: float, y1: float, y2: float, color: str = "#94a3b8"
) -> None:
    draw.line([(cx, y1), (cx, y2 - 7)], fill=color, width=3)
    draw.polygon([(cx - 7, y2 - 9), (cx + 7, y2 - 9), (cx, y2)], fill=color)


def _draw_right_arrow(
    draw: ImageDraw.ImageDraw, x1: float, x2: float, cy: float, color: str = "#64748b"
) -> None:
    draw.line([(x1, cy), (x2 - 8, cy)], fill=color, width=3)
    draw.polygon([(x2 - 10, cy - 7), (x2 - 10, cy + 7), (x2, cy)], fill=color)


def _create_canvas(
    width: int,
    height: int,
    *,
    tag: str,
    title: str,
    subtitle: str,
    right_badge: str = "",
) -> tuple[Image.Image, ImageDraw.ImageDraw, int]:
    img = Image.new("RGB", (width, height), BG_WHITE)
    draw = ImageDraw.ImageDraw(img)

    # Outer editorial frame
    draw.rounded_rectangle(
        [1, 1, width - 2, height - 2],
        radius=18,
        fill=BG_WHITE,
        outline=BORDER_LIGHT,
        width=2,
    )
    # Top subtle accent bar
    draw.rounded_rectangle([32, 22, 40, 74], radius=4, fill="#0284c7")

    f_tag = _get_font(15, bold=True)
    f_title = _get_font(26, bold=True)
    f_sub = _get_font(16, bold=False)
    f_badge = _get_font(15, bold=False)

    tag_w = _draw_pill(
        draw,
        54,
        22,
        tag,
        font=f_tag,
        bg="#e0f2fe",
        border="#bae6fd",
        fg="#0369a1",
        pad_x=11,
        height=24,
    )
    if subtitle:
        sub_x = 54 + tag_w + 12
        max_sub_w = width - sub_x - (280 if right_badge else 44)
        _draw_text(
            draw,
            (sub_x, 34),
            _truncate(subtitle, f_sub, max(120, max_sub_w)),
            font=f_sub,
            fill=TEXT_MUTED,
            anchor="lm",
        )

    title_max_w = width - 54 - (280 if right_badge else 44)
    _draw_text(
        draw,
        (54, 51),
        _truncate(title, f_title, max(240, title_max_w)),
        font=f_title,
        fill=TEXT_PRIMARY,
        bold=True,
    )

    if right_badge:
        badge_text = _truncate(right_badge, f_badge, 240)
        bw = _text_width(f_badge, badge_text) + 24
        _draw_pill(
            draw,
            width - 36 - bw,
            34,
            badge_text,
            font=f_badge,
            bg=BG_SUBTLE,
            border=BORDER_LIGHT,
            fg=TEXT_SECONDARY,
            pad_x=12,
            height=30,
        )

    draw.line([(32, 92), (width - 32, 92)], fill=BORDER_LIGHT, width=2)
    return img, draw, 108


def _draw_footer(
    draw: ImageDraw.ImageDraw, width: int, height: int, text: str | None = None
) -> None:
    f_foot = _get_font(14, bold=False)
    draw.line([(32, height - 42), (width - 32, height - 42)], fill=BORDER_LIGHT, width=1)
    footer_text = (
        text
        or "数据来源：GroupProof 实时工程事实快照（需求基线 · 任务分工 · GitHub 仓库 · 飞书协作 · 正式证据）"
    )
    _draw_text(
        draw,
        (36, height - 22),
        _truncate(footer_text, f_foot, width - 72),
        font=f_foot,
        fill=TEXT_LIGHT,
        anchor="lm",
    )


def _to_png_bytes(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


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


# ── Template 1: Layered Architecture ──────────────────────────────────────────


def _render_layered_architecture(spec: dict[str, Any], facts: dict[str, Any]) -> bytes:
    payload = spec.get("payload") if isinstance(spec.get("payload"), dict) else {}
    layers = payload.get("layers") if isinstance(payload.get("layers"), list) else []
    if not layers:
        layers = _default_architecture_payload(facts)["layers"]
    layers = [ly for ly in layers if isinstance(ly, dict)][:4]

    # Dynamic height based on layer count and whether any layer wraps to 2 rows of nodes
    layer_heights: list[int] = []
    for idx, ly in enumerate(layers):
        nodes = [n for n in (ly.get("nodes") or []) if isinstance(n, dict)][:8]
        has_rich = any(n.get("progress") is not None or n.get("metric") for n in nodes)
        if len(nodes) > 5:
            layer_heights.append(260 if has_rich else 210)
        elif has_rich:
            layer_heights.append(186)
        else:
            layer_heights.append(122 if idx == 0 else 136)

    gap = 34
    total_content_h = sum(layer_heights) + gap * max(0, len(layers) - 1)
    height = max(560, 108 + total_content_h + 62)

    proj = facts.get("project") if isinstance(facts.get("project"), dict) else {}
    counts = facts.get("counts") if isinstance(facts.get("counts"), dict) else {}
    right_badge = (
        f"{proj.get('modules_count', len(facts.get('modules') or []))} 模块 · "
        f"{counts.get('tasks', 0)} 任务 · {counts.get('members', 0)} 成员"
    )

    img, draw, cursor_y = _create_canvas(
        CANVAS_WIDTH,
        height,
        tag=str(spec.get("badge") or "系统架构"),
        title=str(spec.get("title") or "系统架构与模块分工总览图"),
        subtitle=str(spec.get("subtitle") or proj.get("name") or ""),
        right_badge=right_badge,
    )

    f_layer = _get_font(17, bold=True)
    f_node_title = _get_font(17, bold=True)
    f_node_sub = _get_font(14, bold=False)
    f_metric = _get_font(14, bold=True)

    pad_x = 36
    inner_w = CANVAS_WIDTH - pad_x * 2

    for l_idx, ly in enumerate(layers):
        lh = layer_heights[l_idx]
        acc = _accent(ly.get("accent"), l_idx)
        y1 = cursor_y
        y2 = y1 + lh

        # Layer container
        draw.rounded_rectangle(
            [pad_x, y1, CANVAS_WIDTH - pad_x, y2],
            radius=14,
            fill=BG_SUBTLE if l_idx % 2 == 1 else "#ffffff",
            outline=acc["border"] if l_idx == 0 else BORDER_MED,
            width=2,
        )
        # Left vertical strip
        draw.rounded_rectangle([pad_x, y1, pad_x + 8, y2], radius=4, fill=acc["main"])

        layer_name = str(ly.get("name") or f"层级 {l_idx + 1}")
        _draw_text(
            draw,
            (pad_x + 22, y1 + 14),
            _truncate(layer_name, f_layer, inner_w - 40),
            font=f_layer,
            fill=acc["text"],
            bold=True,
        )

        nodes = [n for n in (ly.get("nodes") or []) if isinstance(n, dict)][:8]
        if not nodes:
            nodes = [{"title": layer_name, "subtitle": "核心组件"}]

        cols = min(len(nodes), 5 if len(nodes) <= 5 else 4)
        rows = (len(nodes) + cols - 1) // cols
        card_gap_x = 14
        card_gap_y = 12
        grid_x = pad_x + 22
        grid_y = y1 + 44
        grid_w = inner_w - 40
        grid_h = lh - 56
        card_w = (grid_w - card_gap_x * (cols - 1)) / max(1, cols)
        card_h = (grid_h - card_gap_y * (rows - 1)) / max(1, rows)

        for n_idx, node in enumerate(nodes):
            r = n_idx // cols
            c = n_idx % cols
            n_acc = _accent(
                node.get("accent")
                or (
                    ACCENT_CYCLE[n_idx % 4]
                    if rows == 1 and cols <= 4 and l_idx == 1
                    else ly.get("accent")
                ),
                l_idx + n_idx,
            )
            cx1 = grid_x + c * (card_w + card_gap_x)
            cy1 = grid_y + r * (card_h + card_gap_y)
            cx2 = cx1 + card_w
            cy2 = cy1 + card_h

            draw.rounded_rectangle(
                [cx1, cy1, cx2, cy2],
                radius=10,
                fill=BG_WHITE,
                outline=BORDER_LIGHT,
                width=2,
            )
            draw.rounded_rectangle(
                [cx1 + 1, cy1 + 1, cx2 - 1, cy1 + 6], radius=3, fill=n_acc["main"]
            )

            ntitle = str(node.get("title") or "模块")
            _draw_text(
                draw,
                (cx1 + 14, cy1 + 15),
                _truncate(ntitle, f_node_title, card_w - 28),
                font=f_node_title,
                fill=TEXT_PRIMARY,
                bold=True,
            )

            nsub = str(node.get("subtitle") or "")
            if nsub:
                lines = _wrap_lines(
                    nsub, f_node_sub, card_w - 28, max_lines=2 if card_h >= 100 else 1
                )
                for line_i, line_txt in enumerate(lines):
                    _draw_text(
                        draw,
                        (cx1 + 14, cy1 + 42 + line_i * 20),
                        line_txt,
                        font=f_node_sub,
                        fill=TEXT_MUTED,
                    )

            metric = str(node.get("metric") or "")
            progress = node.get("progress")
            if progress is not None and card_h >= 105:
                pct = max(0, min(100, _safe_int(progress)))
                bar_y = cy2 - 22
                bar_x1 = cx1 + 14
                bar_x2 = cx2 - 14
                if metric:
                    _draw_text(
                        draw,
                        (bar_x1, bar_y - 22),
                        _truncate(metric, f_metric, card_w - 28),
                        font=f_metric,
                        fill=n_acc["text"],
                        bold=True,
                    )
                draw.rounded_rectangle([bar_x1, bar_y, bar_x2, bar_y + 10], radius=5, fill=BG_TRACK)
                fill_w = max(8, (bar_x2 - bar_x1) * pct / 100.0) if pct > 0 else 0
                if fill_w > 0:
                    draw.rounded_rectangle(
                        [bar_x1, bar_y, bar_x1 + fill_w, bar_y + 10],
                        radius=5,
                        fill=n_acc["main"],
                    )
            elif metric:
                _draw_text(
                    draw,
                    (cx1 + 14, cy2 - 24),
                    _truncate(metric, f_metric, card_w - 28),
                    font=f_metric,
                    fill=n_acc["text"],
                    bold=True,
                )

        if l_idx < len(layers) - 1:
            # 3 subtle architectural connectors between layers
            for ratio in (0.25, 0.5, 0.75):
                _draw_down_arrow(draw, pad_x + inner_w * ratio, y2 + 4, y2 + gap - 4)

        cursor_y = y2 + gap

    _draw_footer(draw, CANVAS_WIDTH, height, payload.get("footer"))
    return _to_png_bytes(img)


# ── Template 2: Process / Workflow Pipeline ───────────────────────────────────


def _render_process_flow(spec: dict[str, Any], facts: dict[str, Any]) -> bytes:
    payload = spec.get("payload") if isinstance(spec.get("payload"), dict) else {}
    steps = payload.get("steps") if isinstance(payload.get("steps"), list) else []
    if not steps:
        steps = _default_workflow_payload(facts)["steps"]
    steps = [s for s in steps if isinstance(s, dict)][:6]
    if not steps:
        steps = [{"step": "01", "title": "项目实施", "metric": "进行中", "detail": ""}]

    kpis = [k for k in (payload.get("kpis") or []) if isinstance(k, dict)][:4]
    footer_note = str(payload.get("footer_note") or "")
    height = 560

    proj = facts.get("project") if isinstance(facts.get("project"), dict) else {}
    img, draw, cursor_y = _create_canvas(
        CANVAS_WIDTH,
        height,
        tag=str(spec.get("badge") or "研发流程"),
        title=str(spec.get("title") or "证据驱动的研发协作与验收流程图"),
        subtitle=str(spec.get("subtitle") or proj.get("name") or ""),
        right_badge=f"全周期 {len(steps)} 阶段闭环",
    )

    pad_x = 36
    n = len(steps)
    arrow_gap = 26
    total_w = CANVAS_WIDTH - pad_x * 2
    card_w = (total_w - arrow_gap * (n - 1)) / n
    card_y1 = cursor_y + 14
    card_h = 268
    card_y2 = card_y1 + card_h

    f_step_num = _get_font(15, bold=True)
    f_step_title = _get_font(19 if n <= 5 else 17, bold=True)
    f_metric = _get_font(22 if n <= 5 else 19, bold=True)
    f_detail = _get_font(14, bold=False)

    for idx, st in enumerate(steps):
        acc = _accent(st.get("accent"), idx)
        x1 = pad_x + idx * (card_w + arrow_gap)
        x2 = x1 + card_w

        # Card body
        draw.rounded_rectangle(
            [x1, card_y1, x2, card_y2],
            radius=14,
            fill=BG_SUBTLE,
            outline=BORDER_LIGHT,
            width=2,
        )
        # Top colored accent cap
        draw.rounded_rectangle(
            [x1 + 1, card_y1 + 1, x2 - 1, card_y1 + 8], radius=4, fill=acc["main"]
        )

        step_code = str(st.get("step") or f"{idx + 1:02d}")
        _draw_pill(
            draw,
            x1 + 14,
            card_y1 + 22,
            f"STEP {step_code}",
            font=f_step_num,
            bg=acc["soft"],
            border=acc["border"],
            fg=acc["text"],
            pad_x=10,
            height=24,
        )

        # Stage title (wrap up to 2 lines)
        title_lines = _wrap_lines(
            str(st.get("title") or f"阶段 {idx + 1}"), f_step_title, card_w - 28, max_lines=2
        )
        for li, line_txt in enumerate(title_lines):
            _draw_text(
                draw,
                (x1 + 14, card_y1 + 60 + li * 25),
                line_txt,
                font=f_step_title,
                fill=TEXT_PRIMARY,
                bold=True,
            )

        # Metric highlight box
        metric_y1 = card_y1 + 122
        metric_y2 = metric_y1 + 58
        draw.rounded_rectangle(
            [x1 + 12, metric_y1, x2 - 12, metric_y2],
            radius=10,
            fill=BG_WHITE,
            outline=acc["border"],
            width=1,
        )
        metric_str = str(st.get("metric") or "—")
        metric_font = f_metric
        for try_size in (19, 17, 15, 14):
            if _text_width(metric_font, metric_str) <= card_w - 28:
                break
            metric_font = _get_font(try_size, bold=True)
        _draw_text(
            draw,
            ((x1 + x2) / 2, (metric_y1 + metric_y2) / 2),
            _truncate(metric_str, metric_font, card_w - 26),
            font=metric_font,
            fill=acc["main"],
            bold=True,
            anchor="mm",
        )

        # Detail lines
        detail_lines = _wrap_lines(str(st.get("detail") or ""), f_detail, card_w - 28, max_lines=3)
        for li, line_txt in enumerate(detail_lines):
            _draw_text(
                draw,
                (x1 + 14, metric_y2 + 14 + li * 21),
                line_txt,
                font=f_detail,
                fill=TEXT_SECONDARY,
            )

        if idx < n - 1:
            _draw_right_arrow(
                draw, x2 + 4, x2 + arrow_gap - 4, (card_y1 + card_y2) / 2, color="#64748b"
            )

    # Bottom governance/KPI band
    band_y1 = card_y2 + 24
    band_y2 = height - 56
    draw.rounded_rectangle(
        [pad_x, band_y1, CANVAS_WIDTH - pad_x, band_y2],
        radius=12,
        fill="#f0f9ff",
        outline="#bae6fd",
        width=1,
    )
    f_note = _get_font(15, bold=False)
    f_kpi_lbl = _get_font(13, bold=False)
    f_kpi_val = _get_font(17, bold=True)

    note_text = (
        footer_note
        or "闭环核验机制：需求基线冻结与任务验收标准绑定真实代码/文档证据，确保进度可核验、责任可追溯。"
    )
    if kpis:
        kpi_zone_w = min(560, len(kpis) * 145)
        note_w = total_w - kpi_zone_w - 42
        note_lines = _wrap_lines(note_text, f_note, note_w, max_lines=2)
        for li, txt in enumerate(note_lines):
            _draw_text(
                draw,
                (pad_x + 20, band_y1 + 18 + li * 24),
                txt,
                font=f_note,
                fill="#0c4a6e",
            )
        kx = CANVAS_WIDTH - pad_x - kpi_zone_w - 10
        kw = (kpi_zone_w - 10 * (len(kpis) - 1)) / len(kpis)
        for ki, kpi in enumerate(kpis):
            bx1 = kx + ki * (kw + 10)
            bx2 = bx1 + kw
            draw.rounded_rectangle(
                [bx1, band_y1 + 12, bx2, band_y2 - 12],
                radius=8,
                fill=BG_WHITE,
                outline="#bae6fd",
                width=1,
            )
            _draw_text(
                draw,
                ((bx1 + bx2) / 2, band_y1 + 28),
                _truncate(str(kpi.get("label") or ""), f_kpi_lbl, kw - 12),
                font=f_kpi_lbl,
                fill=TEXT_MUTED,
                anchor="mm",
            )
            _draw_text(
                draw,
                ((bx1 + bx2) / 2, band_y2 - 28),
                _truncate(str(kpi.get("value") or "—"), f_kpi_val, kw - 12),
                font=f_kpi_val,
                fill="#0284c7",
                bold=True,
                anchor="mm",
            )
    else:
        _draw_text(
            draw,
            (pad_x + 20, (band_y1 + band_y2) / 2),
            _truncate(note_text, f_note, total_w - 40),
            font=f_note,
            fill="#0c4a6e",
            anchor="lm",
        )

    _draw_footer(draw, CANVAS_WIDTH, height, payload.get("footer"))
    return _to_png_bytes(img)


# ── Template 3: Milestone Timeline / Progress Chart ───────────────────────────


def _render_milestone_timeline(spec: dict[str, Any], facts: dict[str, Any]) -> bytes:
    payload = spec.get("payload") if isinstance(spec.get("payload"), dict) else {}
    items = payload.get("items") if isinstance(payload.get("items"), list) else []
    if not items:
        default_pl = _default_milestones_payload(facts)
        items = default_pl["items"]
        if not payload.get("summary_badges"):
            payload = {**payload, "summary_badges": default_pl.get("summary_badges", [])}

    items = [it for it in items if isinstance(it, dict)][:10]
    summary_badges = [b for b in (payload.get("summary_badges") or []) if isinstance(b, dict)][:4]

    row_h = 56
    summary_h = 46 if summary_badges else 0
    height = max(460, 118 + summary_h + max(1, len(items)) * row_h + 88)

    proj = facts.get("project") if isinstance(facts.get("project"), dict) else {}
    img, draw, cursor_y = _create_canvas(
        CANVAS_WIDTH,
        height,
        tag=str(spec.get("badge") or "进度里程碑"),
        title=str(spec.get("title") or "阶段里程碑推进与任务完成进度图"),
        subtitle=str(spec.get("subtitle") or proj.get("name") or ""),
        right_badge=f"共 {len(items)} 项阶段节点",
    )

    pad_x = 36
    f_badge_val = _get_font(15, bold=True)

    if summary_badges:
        bx = pad_x
        for bi, b in enumerate(summary_badges):
            acc = _accent(b.get("accent"), bi)
            txt = f"{b.get('label', '')}：{b.get('value', '')}"
            w = _draw_pill(
                draw,
                bx,
                cursor_y,
                txt,
                font=f_badge_val,
                bg=acc["soft"],
                border=acc["border"],
                fg=acc["text"],
                pad_x=14,
                height=32,
            )
            bx += w + 12
        cursor_y += summary_h

    # Column geometry
    label_x = pad_x
    label_w = 340
    bar_x = label_x + label_w + 18
    bar_w = 540
    right_x = bar_x + bar_w + 22
    right_w = CANVAS_WIDTH - pad_x - right_x

    # Gridlines (0%, 25%, 50%, 75%, 100%)
    chart_top = cursor_y + 4
    chart_bottom = chart_top + max(1, len(items)) * row_h
    f_axis = _get_font(13, bold=False)
    for pct in (0, 25, 50, 75, 100):
        gx = bar_x + bar_w * (pct / 100.0)
        draw.line([(gx, chart_top), (gx, chart_bottom + 4)], fill=BORDER_LIGHT, width=1)
        _draw_text(
            draw, (gx, chart_bottom + 18), f"{pct}%", font=f_axis, fill=TEXT_LIGHT, anchor="mm"
        )

    f_row_title = _get_font(16, bold=True)
    f_row_date = _get_font(13, bold=False)
    f_pct = _get_font(15, bold=True)
    f_pill = _get_font(13, bold=True)
    f_meta = _get_font(14, bold=False)

    if not items:
        _draw_text(
            draw,
            (CANVAS_WIDTH / 2, (chart_top + chart_bottom) / 2),
            "暂无阶段里程碑数据",
            font=f_row_title,
            fill=TEXT_MUTED,
            anchor="mm",
        )
    else:
        for idx, it in enumerate(items):
            ry = chart_top + idx * row_h
            if idx % 2 == 0:
                draw.rounded_rectangle(
                    [pad_x - 6, ry + 2, CANVAS_WIDTH - pad_x + 6, ry + row_h - 4],
                    radius=8,
                    fill=BG_SUBTLE,
                )

            title = str(it.get("label") or f"阶段 {idx + 1}")
            date_str = str(it.get("date") or "")
            pct = max(0, min(100, _safe_int(it.get("progress"), 0)))
            status_txt = str(it.get("status") or ("已完成" if pct >= 100 else "进行中"))
            meta_txt = str(it.get("meta") or "")

            tone = str(it.get("tone") or "").lower()
            if not tone:
                if pct >= 100 or "完成" in status_txt:
                    tone = "emerald"
                elif "风险" in status_txt:
                    tone = "amber"
                elif pct > 0:
                    tone = "sky"
                else:
                    tone = "slate"
            acc = _accent(tone, idx)

            # Left: milestone title & date
            if date_str and date_str != "—":
                _draw_text(
                    draw,
                    (label_x + 6, ry + 10),
                    _truncate(title, f_row_title, label_w - 12),
                    font=f_row_title,
                    fill=TEXT_PRIMARY,
                    bold=True,
                )
                _draw_text(
                    draw,
                    (label_x + 6, ry + 33),
                    f"截止：{date_str}",
                    font=f_row_date,
                    fill=TEXT_MUTED,
                )
            else:
                _draw_text(
                    draw,
                    (label_x + 6, ry + row_h / 2 - 2),
                    _truncate(title, f_row_title, label_w - 12),
                    font=f_row_title,
                    fill=TEXT_PRIMARY,
                    bold=True,
                    anchor="lm",
                )

            # Center: progress bar
            track_y1 = ry + 16
            track_y2 = ry + 38
            draw.rounded_rectangle(
                [bar_x, track_y1, bar_x + bar_w, track_y2],
                radius=11,
                fill="#e2e8f0",
            )
            fill_w = bar_w * pct / 100.0
            if fill_w >= 8:
                draw.rounded_rectangle(
                    [bar_x, track_y1, bar_x + fill_w, track_y2],
                    radius=11,
                    fill=acc["main"],
                )
            pct_label = f"{pct}%"
            if pct >= 18:
                _draw_text(
                    draw,
                    (bar_x + fill_w - 10, (track_y1 + track_y2) / 2),
                    pct_label,
                    font=f_pct,
                    fill="#ffffff",
                    bold=True,
                    anchor="rm",
                )
            else:
                _draw_text(
                    draw,
                    (bar_x + fill_w + 10, (track_y1 + track_y2) / 2),
                    pct_label,
                    font=f_pct,
                    fill=acc["text"],
                    bold=True,
                    anchor="lm",
                )

            # Right: status pill + deliverable/task meta
            pw = _draw_pill(
                draw,
                right_x,
                ry + 14,
                status_txt,
                font=f_pill,
                bg=acc["soft"],
                border=acc["border"],
                fg=acc["text"],
                pad_x=10,
                height=26,
                max_width=110,
            )
            if meta_txt:
                _draw_text(
                    draw,
                    (right_x + pw + 12, ry + 27),
                    _truncate(meta_txt, f_meta, max(60, right_w - pw - 14)),
                    font=f_meta,
                    fill=TEXT_SECONDARY,
                    anchor="lm",
                )

    _draw_footer(draw, CANVAS_WIDTH, height, payload.get("footer"))
    return _to_png_bytes(img)


# ── Template 4: Category Breakdown (1-panel or 2-panel ranked bars) ───────────


def _render_category_breakdown(spec: dict[str, Any], facts: dict[str, Any]) -> bytes:
    payload = spec.get("payload") if isinstance(spec.get("payload"), dict) else {}
    panels = payload.get("panels") if isinstance(payload.get("panels"), list) else []
    if not panels:
        panels = _default_evidence_payload(facts)["panels"]
    panels = [p for p in panels if isinstance(p, dict)][:2]
    if not panels:
        panels = [{"title": "分类分布", "items": []}]

    max_rows = max((len(p.get("items") or []) for p in panels), default=1)
    max_rows = max(3, min(7, max_rows))
    height = max(540, 232 + max_rows * 62)

    proj = facts.get("project") if isinstance(facts.get("project"), dict) else {}
    img, draw, cursor_y = _create_canvas(
        CANVAS_WIDTH,
        height,
        tag=str(spec.get("badge") or "结构分析"),
        title=str(spec.get("title") or "正式证据来源分布与飞书协作结论结构图"),
        subtitle=str(spec.get("subtitle") or proj.get("name") or ""),
        right_badge=f"{len(panels)} 维统计视图",
    )

    pad_x = 36
    gap = 24
    panel_w = (CANVAS_WIDTH - pad_x * 2 - gap * (len(panels) - 1)) / len(panels)
    panel_y1 = cursor_y + 4
    panel_y2 = height - 58

    f_ptitle = _get_font(19, bold=True)
    f_ptotal = _get_font(14, bold=True)
    f_label = _get_font(15, bold=False)
    f_val = _get_font(15, bold=True)
    f_foot = _get_font(13, bold=False)

    for p_idx, panel in enumerate(panels):
        px1 = pad_x + p_idx * (panel_w + gap)
        px2 = px1 + panel_w
        p_acc = _accent(panel.get("accent"), p_idx * 2)

        draw.rounded_rectangle(
            [px1, panel_y1, px2, panel_y2],
            radius=14,
            fill=BG_SUBTLE,
            outline=BORDER_LIGHT,
            width=2,
        )

        # Panel header
        ptitle = str(panel.get("title") or f"统计维度 {p_idx + 1}")
        _draw_text(
            draw,
            (px1 + 22, panel_y1 + 20),
            _truncate(ptitle, f_ptitle, panel_w - 220),
            font=f_ptitle,
            fill=TEXT_PRIMARY,
            bold=True,
        )
        total_label = str(panel.get("total_label") or "")
        if total_label:
            tl = _truncate(total_label, f_ptotal, 220)
            tl_w = _text_width(f_ptotal, tl) + 22
            _draw_pill(
                draw,
                px2 - 20 - tl_w,
                panel_y1 + 18,
                tl,
                font=f_ptotal,
                bg=p_acc["soft"],
                border=p_acc["border"],
                fg=p_acc["text"],
                pad_x=11,
                height=26,
            )

        draw.line(
            [(px1 + 20, panel_y1 + 58), (px2 - 20, panel_y1 + 58)], fill=BORDER_LIGHT, width=1
        )

        raw_items = [it for it in (panel.get("items") or []) if isinstance(it, dict)][:7]
        total_sum = sum(max(0.0, _safe_num(it.get("value"))) for it in raw_items)
        max_val = (
            max((max(0.0, _safe_num(it.get("value"))) for it in raw_items), default=1.0) or 1.0
        )

        content_top = panel_y1 + 74
        content_bottom = panel_y2 - 52
        if not raw_items or total_sum <= 0:
            empty_msg = str(panel.get("empty_message") or "当前快照暂无该维度数据")
            _draw_text(
                draw,
                ((px1 + px2) / 2, (content_top + content_bottom) / 2),
                _truncate(empty_msg, f_label, panel_w - 60),
                font=f_label,
                fill=TEXT_MUTED,
                anchor="mm",
            )
        else:
            row_step = min(58, (content_bottom - content_top) / max(1, len(raw_items)))
            bar_x1 = px1 + 22
            bar_x2 = px2 - 22
            bar_total_w = bar_x2 - bar_x1

            for r_idx, it in enumerate(raw_items):
                ry = content_top + r_idx * row_step
                val = max(0.0, _safe_num(it.get("value")))
                pct = round(val * 100.0 / total_sum, 1) if total_sum > 0 else 0.0
                unit = str(it.get("unit") or "")
                val_fmt = f"{int(val)}" if float(val).is_integer() else f"{val:.1f}"
                val_text = f"{val_fmt}{unit} ({pct:.1f}%)"
                acc = _accent(it.get("accent"), p_idx * 2 + r_idx)

                # Label row
                _draw_text(
                    draw,
                    (bar_x1, ry + 2),
                    _truncate(str(it.get("label") or ""), f_label, bar_total_w - 150),
                    font=f_label,
                    fill=TEXT_SECONDARY,
                )
                _draw_text(
                    draw,
                    (bar_x2, ry + 2),
                    val_text,
                    font=f_val,
                    fill=TEXT_PRIMARY,
                    bold=True,
                    anchor="ra",
                )

                # Bar track + fill
                by1 = ry + 26
                by2 = by1 + 16
                draw.rounded_rectangle([bar_x1, by1, bar_x2, by2], radius=8, fill="#e2e8f0")
                fw = max(10.0, bar_total_w * (val / max_val)) if val > 0 else 0.0
                if fw > 0:
                    draw.rounded_rectangle(
                        [bar_x1, by1, bar_x1 + fw, by2], radius=8, fill=acc["main"]
                    )

        # Panel footnote strip
        pfoot = str(panel.get("footnote") or "")
        if pfoot:
            draw.rounded_rectangle(
                [px1 + 18, panel_y2 - 40, px2 - 18, panel_y2 - 12],
                radius=8,
                fill=BG_WHITE,
                outline=BORDER_LIGHT,
                width=1,
            )
            _draw_text(
                draw,
                (px1 + 30, panel_y2 - 26),
                _truncate(pfoot, f_foot, panel_w - 60),
                font=f_foot,
                fill=TEXT_MUTED,
                anchor="lm",
            )

    _draw_footer(draw, CANVAS_WIDTH, height, payload.get("footer"))
    return _to_png_bytes(img)


# ── Template 5: Member Multi-Dimensional Comparison ───────────────────────────


def _render_member_comparison(spec: dict[str, Any], facts: dict[str, Any]) -> bytes:
    payload = spec.get("payload") if isinstance(spec.get("payload"), dict) else {}
    members = payload.get("members") if isinstance(payload.get("members"), list) else []
    series = payload.get("series") if isinstance(payload.get("series"), list) else []
    if not members or not series:
        default_pl = _default_contribution_payload(facts)
        if not members:
            members = default_pl["members"]
        if not series:
            series = default_pl["series"]

    members = [m for m in members if isinstance(m, dict)][:8]
    series = [s for s in series if isinstance(s, dict)][:4]

    n_series = max(1, len(series))
    group_h = max(86, n_series * 22 + 26)
    height = max(520, 176 + max(1, len(members)) * (group_h + 12) + 64)

    proj = facts.get("project") if isinstance(facts.get("project"), dict) else {}
    img, draw, cursor_y = _create_canvas(
        CANVAS_WIDTH,
        height,
        tag=str(spec.get("badge") or "贡献对比"),
        title=str(spec.get("title") or "团队成员多维贡献与分工对比图"),
        subtitle=str(spec.get("subtitle") or proj.get("name") or ""),
        right_badge=f"共 {len(members)} 名活跃成员",
    )

    pad_x = 36
    f_legend = _get_font(15, bold=True)
    f_name = _get_font(18, bold=True)
    f_role = _get_font(13, bold=True)
    f_sub = _get_font(13, bold=False)
    f_val = _get_font(13, bold=True)

    # Top Legend bar
    lx = pad_x
    ly = cursor_y + 2
    for s_idx, s in enumerate(series):
        acc = _accent(s.get("accent"), s_idx)
        draw.rounded_rectangle([lx, ly + 4, lx + 16, ly + 20], radius=4, fill=acc["main"])
        slabel = str(s.get("label") or f"维度 {s_idx + 1}")
        _draw_text(
            draw, (lx + 24, ly + 12), slabel, font=f_legend, fill=TEXT_SECONDARY, anchor="lm"
        )
        lx += 24 + _text_width(f_legend, slabel) + 28

    cursor_y += 42

    # Compute per-series max for clean normalized bar lengths
    series_max: dict[str, float] = {}
    for s in series:
        skey = str(s.get("key") or "")
        mx = 0.0
        for m in members:
            vals = m.get("values") if isinstance(m.get("values"), dict) else {}
            entry = vals.get(skey)
            v = _safe_num(entry.get("value") if isinstance(entry, dict) else entry, 0.0)
            if v > mx:
                mx = v
        series_max[skey] = mx if mx > 0 else 1.0

    left_w = 270
    bar_x1 = pad_x + left_w + 18
    val_col_w = 155
    bar_max_w = CANVAS_WIDTH - pad_x - val_col_w - bar_x1 - 14

    if not members:
        _draw_text(
            draw,
            (CANVAS_WIDTH / 2, cursor_y + 120),
            "暂无成员贡献数据",
            font=f_name,
            fill=TEXT_MUTED,
            anchor="mm",
        )
    else:
        for m_idx, m in enumerate(members):
            gy1 = cursor_y + m_idx * (group_h + 12)
            gy2 = gy1 + group_h
            draw.rounded_rectangle(
                [pad_x, gy1, CANVAS_WIDTH - pad_x, gy2],
                radius=12,
                fill=BG_SUBTLE if m_idx % 2 == 0 else BG_WHITE,
                outline=BORDER_LIGHT,
                width=1,
            )

            # Left member identity block
            mname = str(m.get("name") or f"成员 {m_idx + 1}")
            mrole = str(m.get("role") or "成员")
            msub = str(m.get("subtitle") or "")
            name_w = _text_width(f_name, _truncate(mname, f_name, left_w - 90))
            _draw_text(
                draw,
                (pad_x + 18, gy1 + 18),
                _truncate(mname, f_name, left_w - 90),
                font=f_name,
                fill=TEXT_PRIMARY,
                bold=True,
            )
            role_acc = _accent("sky" if mrole == "组长" else "slate")
            _draw_pill(
                draw,
                pad_x + 26 + name_w,
                gy1 + 17,
                mrole,
                font=f_role,
                bg=role_acc["soft"],
                border=role_acc["border"],
                fg=role_acc["text"],
                pad_x=9,
                height=22,
            )
            if msub:
                sub_lines = _wrap_lines(msub, f_sub, left_w - 26, max_lines=2)
                for li, stxt in enumerate(sub_lines):
                    _draw_text(
                        draw,
                        (pad_x + 18, gy1 + 48 + li * 18),
                        stxt,
                        font=f_sub,
                        fill=TEXT_MUTED,
                    )

            # Vertical divider
            draw.line(
                [(bar_x1 - 12, gy1 + 12), (bar_x1 - 12, gy2 - 12)], fill=BORDER_LIGHT, width=1
            )

            # Grouped bars for this member
            vals = m.get("values") if isinstance(m.get("values"), dict) else {}
            bar_h = 14
            row_pitch = (group_h - 20) / n_series
            for s_idx, s in enumerate(series):
                skey = str(s.get("key") or "")
                acc = _accent(s.get("accent"), s_idx)
                entry = vals.get(skey)
                raw_v = _safe_num(entry.get("value") if isinstance(entry, dict) else entry, 0.0)
                vlabel = (
                    str(entry.get("label"))
                    if isinstance(entry, dict) and entry.get("label") is not None
                    else (f"{int(raw_v)}" if float(raw_v).is_integer() else f"{raw_v:.1f}")
                )

                by = gy1 + 12 + s_idx * row_pitch + (row_pitch - bar_h) / 2
                draw.rounded_rectangle(
                    [bar_x1, by, bar_x1 + bar_max_w, by + bar_h],
                    radius=7,
                    fill="#e2e8f0",
                )
                ratio = (
                    max(0.0, min(1.0, raw_v / series_max[skey])) if series_max[skey] > 0 else 0.0
                )
                if raw_v > 0:
                    fw = max(12.0, bar_max_w * ratio)
                    draw.rounded_rectangle(
                        [bar_x1, by, bar_x1 + fw, by + bar_h],
                        radius=7,
                        fill=acc["main"],
                    )
                _draw_text(
                    draw,
                    (bar_x1 + bar_max_w + 12, by + bar_h / 2),
                    _truncate(vlabel, f_val, val_col_w),
                    font=f_val,
                    fill=TEXT_SECONDARY,
                    bold=True,
                    anchor="lm",
                )

    _draw_footer(draw, CANVAS_WIDTH, height, payload.get("footer"))
    return _to_png_bytes(img)


# ── Default Fact-Grounded Spec Builders (Fallback when AI omits visuals) ──────


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
            "subtitle": f"核验 {ev.get('verification_runs', 0)} 次 · 成果 {ev.get('formal_outcomes', 0)} 项",
        },
        {"title": "结项报告与导出", "subtitle": "Web 画布 · PDF · Word DOCX"},
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
            "subtitle": f"{ev.get('verification_runs', 0)} 次验收辅助 · 智能报告撰写",
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
                "title": "GitHub/飞书协作",
                "metric": f"{github.get('commits', 0)} 提交 / {feishu.get('total_messages', 0)} 讨论",
                "detail": f"{pr_merged} 合并 PR · {feishu.get('total_conclusions', 0)} 协作结论",
                "accent": "violet",
            },
            {
                "step": "04",
                "title": "不可变证据采纳",
                "metric": f"{ev_tot} 条正式证据",
                "detail": f"覆盖 {ev.get('tasks_with_evidence', 0)}/{t_tot} 任务 ({ev_cov}%)",
                "accent": "amber",
            },
            {
                "step": "05",
                "title": "AI + 人工验收",
                "metric": f"{ev.get('criteria_total', 0)} 条标准",
                "detail": f"{ev.get('verification_runs', 0)} 次核验 · {ev.get('formal_outcomes', 0)} 正式成果",
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
        "footer_note": "全流程可溯源闭环：代码与交付产物变更自动触发证据校验，AI 辅助验收后由人工确认生效。",
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
        else ("正式证据贡献" if has_ev_member else "GitHub PR 合并/参与")
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


def build_default_visual_specs(facts: dict[str, Any]) -> list[dict[str, Any]]:
    """Build fact-grounded fallback visual specs tailored to the available project data."""
    proj_name = str((facts.get("project") or {}).get("name") or "项目")
    specs: list[dict[str, Any]] = [
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
            "subtitle": f"{proj_name} · 从需求基线到结项归档的六步闭环",
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
    return specs


# ── Sanitization & Validation for AI-Authored Visual Specs ────────────────────


def sanitize_visual_specs(raw_visuals: Any, facts: dict[str, Any]) -> list[dict[str, Any]]:
    """Validate and normalize AI-proposed visual specs into safe declarative specs."""
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
        subtitle = str(item.get("subtitle") or "").strip()[:100]
        badge = str(item.get("badge") or "").strip()[:16]
        raw_caption = str(item.get("caption") or title).strip()[:120]
        payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}

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

    # Sort by chapter order and assign clean sequential "图 N：" prefixes
    cleaned.sort(key=lambda sp: section_order_rank.get(sp["section_key"], 99))
    for fig_no, sp in enumerate(cleaned, start=1):
        cap = re.sub(r"^图\s*\d+\s*[：:]\s*", "", sp["caption"]).strip() or sp["title"]
        sp["caption"] = f"图 {fig_no}：{cap}"
    return cleaned


# ── Unified Rendering Entry Points ────────────────────────────────────────────


_TEMPLATE_RENDERERS = {
    "layered_architecture": _render_layered_architecture,
    "process_flow": _render_process_flow,
    "milestone_timeline": _render_milestone_timeline,
    "category_breakdown": _render_category_breakdown,
    "member_comparison": _render_member_comparison,
}


def render_visual_spec(spec: dict[str, Any], facts: dict[str, Any] | None = None) -> bytes:
    """Render any single declarative visual spec into crisp high-DPI PNG bytes."""
    template = str(spec.get("template") or "")
    renderer = _TEMPLATE_RENDERERS.get(template)
    if renderer is None:
        raise ValueError(f"Unsupported visual template: {template}")
    return renderer(spec, facts or {})


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


def render_chart_from_snapshot(
    data_snapshot: dict[str, Any],
    chart_key: str,
    *,
    fallback_facts: dict[str, Any] | None = None,
) -> bytes | None:
    """Render a chart PNG from a report snapshot's `visuals` / `facts`."""
    spec, facts = find_visual_spec(data_snapshot, chart_key, fallback_facts=fallback_facts)
    if spec is None:
        return None
    return render_visual_spec(spec, facts)
