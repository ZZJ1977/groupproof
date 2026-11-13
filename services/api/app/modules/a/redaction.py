"""A6 飞书消息脱敏：把手机号、邮箱、证件号、银行卡号和密钥换成占位符再入库。

只处理能可靠识别的格式，目标是不让明显的个人信息和密钥进入快照和证据；
不是通用的隐私审查，识别不到的内容仍可能保留，所以快照只给本项目成员读取。
"""

from __future__ import annotations

import re

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_PHONE = re.compile(r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)")
_ID_CARD = re.compile(r"(?<![\dXx])\d{17}[\dXx](?![\dXx])")
_CARD_RUN = re.compile(r"(?<![\d-])\d(?:[ -]?\d){15,18}(?![\d-])")
_TOKEN = re.compile(
    r"\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[baprs]|AKIA)[-_A-Za-z0-9]{16,}\b"
    r"|Bearer\s+[A-Za-z0-9._~+/-]{16,}",
    re.IGNORECASE,
)
_SECRET_FIELD = re.compile(
    r"(密码|口令|密钥|password|passwd|pwd|secret|token|api[_-]?key)(\s*[:：=是为]\s*)(\S+)",
    re.IGNORECASE,
)


def _luhn(digits: str) -> bool:
    total = 0
    for index, char in enumerate(reversed(digits)):
        number = int(char)
        if index % 2 == 1:
            number = number * 2 - 9 if number * 2 > 9 else number * 2
        total += number
    return total % 10 == 0


def _card(match: re.Match[str]) -> str:
    digits = re.sub(r"\D", "", match.group(0))
    return "[卡号]" if 16 <= len(digits) <= 19 and _luhn(digits) else match.group(0)


def redact_text(text: str) -> str:
    """返回脱敏后的文本；占位符形如 [手机号]、[邮箱]。"""
    text = _TOKEN.sub("[密钥]", text)
    text = _SECRET_FIELD.sub(lambda m: f"{m.group(1)}{m.group(2)}[已隐藏]", text)
    text = _EMAIL.sub("[邮箱]", text)
    text = _ID_CARD.sub("[证件号]", text)
    text = _CARD_RUN.sub(_card, text)
    return _PHONE.sub("[手机号]", text)
