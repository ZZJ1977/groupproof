"""Versioned, cached Markdown Skill loader for D4 AI closing reports."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

SKILLS_DIR = Path(__file__).resolve().parent

SKILL_REPORT_WRITING = "report_writing_skill.md"
SKILL_REPORT_VISUAL = "report_visual_skill.md"

KNOWN_SKILLS: tuple[str, ...] = (
    SKILL_REPORT_WRITING,
    SKILL_REPORT_VISUAL,
)


@lru_cache(maxsize=16)
def load_skill(filename: str) -> str:
    """Load a built-in Markdown skill document from the skills package (cached)."""
    safe_name = Path(filename).name
    if safe_name != filename or not safe_name.endswith(".md"):
        raise ValueError(f"Invalid skill filename: {filename}")
    path = SKILLS_DIR / safe_name
    if not path.is_file():
        raise FileNotFoundError(f"Skill file not found: {path}")
    return path.read_text(encoding="utf-8").strip()


def clear_skill_cache() -> None:
    """Clear the cached skill contents (primarily for unit tests)."""
    load_skill.cache_clear()


__all__ = [
    "KNOWN_SKILLS",
    "SKILLS_DIR",
    "SKILL_REPORT_VISUAL",
    "SKILL_REPORT_WRITING",
    "clear_skill_cache",
    "load_skill",
]
