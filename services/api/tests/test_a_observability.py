"""A8：Sentry 只在配置了 DSN 时启用，并且发送前去掉敏感内容。"""

from __future__ import annotations

from app import observability


def test_disabled_without_dsn(monkeypatch):
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    assert observability.init_sentry() is False


def test_enabled_with_dsn(monkeypatch):
    import sentry_sdk

    calls = {}
    monkeypatch.setenv("SENTRY_DSN", "https://key@example.invalid/1")
    monkeypatch.setenv("SENTRY_TRACES_SAMPLE_RATE", "9")
    monkeypatch.setattr(sentry_sdk, "init", lambda **kw: calls.update(kw))
    assert observability.init_sentry() is True
    assert calls["send_default_pii"] is False and calls["traces_sample_rate"] == 1.0
    assert calls["before_send"] is observability.scrub_event


def test_scrub_removes_sensitive_request_parts():
    event = {
        "request": {
            "url": "http://x/api/v1/a/uploads",
            "method": "POST",
            "headers": {"cookie": "s=1", "x-csrf-token": "t"},
            "cookies": {"s": "1"},
            "data": {"text": "secret"},
            "query_string": "token=abc",
        },
        "user": {"email": "a@b.c"},
        "exception": {"values": []},
    }
    cleaned = observability.scrub_event(event)
    assert cleaned["request"] == {"url": "http://x/api/v1/a/uploads", "method": "POST"}
    assert "user" not in cleaned and "exception" in cleaned
