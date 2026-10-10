"""安全原语：会话令牌、验证码 HMAC、returnTo 白名单、邮箱/用户名规范化、CSRF/Origin。"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from datetime import datetime, timedelta
from urllib.parse import urlparse

from .config import get_settings

SAFE_LOCALES = ("zh-Hans", "zh-Hant", "en")

# 旧值映射（§8.2）
LEGACY_LOCALE_MAP = {
    "zh": "zh-Hans",
    "zh-CN": "zh-Hans",
    "zh-Hans": "zh-Hans",
    "zh-TW": "zh-Hant",
    "zh-HK": "zh-Hant",
    "zh-MO": "zh-Hant",
    "zh-Hant": "zh-Hant",
    "en": "en",
}


def normalize_locale(value: str | None) -> str | None:
    if not value:
        return None
    key = value.strip()
    if key in LEGACY_LOCALE_MAP:
        return LEGACY_LOCALE_MAP[key]
    if key.lower().startswith("zh-hant"):
        return "zh-Hant"
    if key.lower().startswith("zh-hans"):
        return "zh-Hans"
    base = key.split("-")[0].lower()
    if base == "zh":
        return "zh-Hans"
    if base == "en":
        return "en"
    return None


def pick_locale_from_accept_language(header: str | None) -> str:
    """Accept-Language → 最合适的受支持语言；显式 Hant/Hans 脚本优先于地区。"""
    if not header:
        return "zh-Hans"
    entries: list[tuple[str, float]] = []
    for part in header.split(","):
        bits = part.strip().split(";")
        tag = bits[0].strip()
        q = 1.0
        for extra in bits[1:]:
            if extra.strip().startswith("q="):
                try:
                    q = float(extra.strip()[2:])
                except ValueError:
                    q = 0.0
        entries.append((tag, q))
    entries.sort(key=lambda item: -item[1])
    for tag, _q in entries:
        resolved = normalize_locale(tag)
        if resolved:
            return resolved
    return "zh-Hans"


def normalize_username(value: str) -> str:
    return value.strip().lower()


USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]{2,32}$")
NAME_MAX = 80


def validate_name(value: str) -> str:
    trimmed = value.strip()
    if not (1 <= len(trimmed) <= NAME_MAX):
        raise ValueError("name_length")
    return trimmed


def validate_username(value: str) -> str:
    trimmed = value.strip()
    if not USERNAME_RE.fullmatch(trimmed):
        raise ValueError("username_format")
    return trimmed


def normalize_email(value: str) -> str:
    """邮箱归一化：去首尾空白 + ASCII 小写；拒绝控制字符与畸形输入。"""
    raw = value.strip()
    if not raw or any(ord(ch) < 32 for ch in raw) or " " in raw:
        raise ValueError("email_format")
    return raw.lower()


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def check_email_format(value: str) -> str:
    normalized = normalize_email(value)
    if len(normalized) > 254 or not EMAIL_RE.fullmatch(normalized):
        raise ValueError("email_format")
    return normalized


def email_domain_allowed(normalized: str, identity: str) -> bool:
    """精确域名匹配（禁止 includes/无边界后缀匹配）。

    学生：student.must.edu.mo；教师：must.edu.mo（不含子域，实际规则上线前确认）。
    """
    domain = normalized.rsplit("@", 1)[1]
    settings = get_settings()
    allowed = settings.student_email_domain if identity == "student" else settings.teacher_email_domain
    return domain == allowed


def student_id_valid(value: str, normalized_email: str | None = None) -> bool:
    settings = get_settings()
    if not re.fullmatch(settings.student_id_pattern, value.strip()):
        return False
    if settings.student_id_email_rule == "match_prefix" and normalized_email:
        return normalized_email.split("@", 1)[0] == value.strip()
    return True


# --- 令牌 / 验证码 ---


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def code_hmac(code: str) -> str:
    key = get_settings().email_challenge_hmac_key.encode()
    return hmac.new(key, code.encode(), hashlib.sha256).hexdigest()


def verify_code_hmac(code: str, digest: str) -> bool:
    return hmac.compare_digest(code_hmac(code), digest)


# --- 账号密码凭据 ---

import bcrypt  # noqa: E402
from argon2 import PasswordHasher  # noqa: E402
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError  # noqa: E402

PASSWORD_MIN = 15  # 新设/重置密码（方案 §8.1 建议）；历史密码按原哈希验证，不受新策略拒绝
PASSWORD_MAX = 128
PASSWORD_MAX_BYTES = 72  # 仅历史 bcrypt 凭据的验证边界
BCRYPT_ROUNDS = 12
_argon = PasswordHasher(time_cost=2, memory_cost=19 * 1024, parallelism=1)  # OWASP 起始参数 m=19MiB,t=2,p=1

# 本地常见弱口令黑名单（不依赖外部泄露库，不回传原密码）
_COMMON_PASSWORDS = {
    "password", "password1", "password123", "12345678", "123456789", "1234567890",
    "qwertyuiop", "iloveyou", "admin12345", "letmein123", "welcome123", "abc123456",
}


def validate_password(value: str) -> str:
    """新设/重置密码策略：15–128 字符，允许长口令/空格/Unicode 与粘贴，不强制复杂组合；禁止常见弱口令。"""
    raw = value or ""
    if len(raw) < PASSWORD_MIN or len(raw) > PASSWORD_MAX or not raw.strip():
        raise ValueError("password_policy")
    if raw.lower() in _COMMON_PASSWORDS:
        raise ValueError("password_too_common")
    return raw


def hash_password(plain: str) -> str:
    """新设/重置密码使用 Argon2id（OWASP Password Storage）。"""
    return _argon.hash(plain)


def hash_password_legacy(plain: str) -> str:
    """历史 bcrypt 凭据验证兼容（不再用于新密码）。"""
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode("ascii")


def verify_password(plain: str, password_hash: str) -> bool:
    """按哈希前缀分派：$argon2*（新）/ $2*（历史 bcrypt，保留 72 字节边界语义）。"""
    if password_hash.startswith("$2"):
        try:
            return bcrypt.checkpw(plain.encode("utf-8"), password_hash.encode("ascii"))
        except ValueError:
            return False
    try:
        return _argon.verify(password_hash, plain)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def password_algo_of(password_hash: str) -> str:
    return "bcrypt" if password_hash.startswith("$2") else "argon2id"


def needs_rehash(password_hash: str) -> bool:
    return password_hash.startswith("$2")


def normalize_login_identifier(value: str) -> tuple[str, str]:
    """登录标识归一化：返回 (kind, normalized)；kind ∈ {username, email}。"""
    raw = (value or "").strip()
    if "@" in raw:
        return "email", check_email_format(raw)
    return "username", normalize_username(raw)


# --- returnTo 白名单（§4.3）---


def safe_return_to(value: str | None) -> str | None:
    """只接受通过检查的站内 returnTo；拒绝外部网址、//host、反斜杠及编码绕过。"""
    if not value:
        return None
    candidate = value.strip()
    if not candidate.startswith("/") or candidate.startswith("//") or "\\" in candidate:
        return None
    from urllib.parse import unquote

    decoded = unquote(candidate)
    if "\\" in decoded or decoded.startswith("//"):
        return None  # 拒绝编码绕过
    parsed = urlparse(candidate)
    if parsed.scheme or parsed.netloc:
        return None
    path = parsed.path
    forbidden_prefixes = ("/api", "/login", "/account", "/onboarding")
    for prefix in forbidden_prefixes:
        if path == prefix or path.startswith(prefix + "/") or path.startswith(prefix + "?"):
            return None
    return candidate


def csrf_and_origin_ok(origin_header: str | None, csrf_header: str | None, session_csrf: str) -> bool:
    settings = get_settings()
    if origin_header is not None and origin_header != settings.app_origin:
        return False
    if not csrf_header or not hmac.compare_digest(csrf_header, session_csrf):
        return False
    return True


def within_recent_auth(last_login_at: datetime | None, now: datetime) -> bool:
    if last_login_at is None:
        return False
    return (now - last_login_at) <= timedelta(seconds=get_settings().recent_auth_window)
