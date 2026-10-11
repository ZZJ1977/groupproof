"""验收临时密令（仅非 real 模式）：注册直达资料页入口、验证码直通、关闭与生产安全性。

覆盖点：
- 密令开通的是真实测试账户 + 真实会话，后续注册进度/门禁与真实用户完全一致；
- 学校邮箱“密令直通”与真实验证码共用同一绑定落库路径，不伪造验证事实；
- 未配置（默认）时密令失效，按真实邮箱校验/验证码流程拒绝；
- APP_MODE=real 配置密令直接启动失败（无后门）。
"""
from __future__ import annotations

import pytest

from tests.conftest import csrf_headers, session_csrf
from tests.flows import ORIGIN, profile_payload, register_via_email


@pytest.fixture()
def acceptance_token():
    """按需开关验收密令（与 E 系列同风格：直接切换共享 Settings 实例，结束后恢复）。"""
    from app.config import get_settings

    original = get_settings().acceptance_test_token

    def set_token(value: str):
        get_settings().acceptance_test_token = value

    yield set_token
    get_settings().acceptance_test_token = original


def test_t1_token_entry_creates_real_account_and_session(client, acceptance_token):
    """T1：注册邮箱框输入密令 → 全新测试账户 + 受限会话（资料页为下一步，不跳过必填阶段）。"""
    acceptance_token("202610")
    response = client.post("/api/v1/auth/email/registrations", json={"email": "202610", "locale": "zh-Hans"}, headers=ORIGIN)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["testEntry"] is True
    assert body["accountState"] == "profile_required"
    assert body["username"].startswith("test")
    assert "gp_session=" in response.headers.get("set-cookie", "")

    reg = client.get("/api/v1/me").json()["registration"]
    assert reg["profileComplete"] is False
    assert reg["identityConfirmed"] is False
    assert reg["requiredCompletedCount"] == 0
    assert reg["canEnterWorkspace"] is False
    assert reg["securityComplete"] is True  # 测试账户登录邮箱视为已验证（可选项在注册时即满足）
    assert client.get("/api/v1/home/summary").status_code == 403


def test_t2_token_as_school_email_code_verifies(client, acceptance_token):
    """T2：验证码框输入密令 → 直通确认当前待验证学校邮箱（同一绑定路径，状态与真实验证一致）。"""
    acceptance_token("202610")
    client.post("/api/v1/auth/email/registrations", json={"email": "202610"}, headers=ORIGIN)
    csrf = session_csrf(client)
    saved = client.patch(
        "/api/v1/me/profile",
        json=profile_payload(
            name="王小明",
            username="tkstudent",
            student_id="2023123456",
            identity="student",
            email="2023123456@student.must.edu.mo",
            expected_version=1,
        ),
        headers=csrf_headers(csrf),
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["registration"]["schoolEmailVerified"] is False

    verified = client.post(
        "/api/v1/me/school-email/verify",
        json={"challengeId": "", "code": "202610"},
        headers=csrf_headers(session_csrf(client)),
    )
    assert verified.status_code == 200, verified.text
    reg = verified.json()["registration"]
    assert reg["schoolEmailVerified"] is True
    assert reg["identityConfirmed"] is True
    assert reg["requiredCompletedCount"] == 3
    assert reg["canEnterWorkspace"] is True
    assert client.get("/api/v1/home/summary").status_code == 200


def test_t3_token_inert_without_config(client, acceptance_token):
    """T3：未配置密令时一切走真实流程（邮箱格式校验/验证码消费），不存在隐藏后门。"""
    acceptance_token("")
    response = client.post("/api/v1/auth/email/registrations", json={"email": "202610"}, headers=ORIGIN)
    assert response.status_code == 400, response.text  # 无密令时按真实邮箱格式校验拒绝
    assert "testEntry" not in response.text

    # 真实邮箱建档流程不受影响；伪验证码（无挑战/未消费）不直通
    register_via_email(client, "s1@qq.com", "tknosw")
    csrf = session_csrf(client)
    saved = client.patch(
        "/api/v1/me/profile",
        json=profile_payload(
            name="王小明",
            username="tknosw",
            student_id="2023123456",
            identity="student",
            email="2023123456@student.must.edu.mo",
            expected_version=1,
        ),
        headers=csrf_headers(csrf),
    )
    assert saved.status_code == 200, saved.text
    rejected = client.post(
        "/api/v1/me/school-email/verify",
        json={"challengeId": "", "code": "202610"},
        headers=csrf_headers(session_csrf(client)),
    )
    assert rejected.status_code != 200  # 无密令时空 challengeId/伪验证码一律拒绝
    assert client.get("/api/v1/me").json()["registration"]["schoolEmailVerified"] is False


def test_t4_real_mode_rejects_acceptance_token():
    """T4：APP_MODE=real 配置验收密令直接启动失败（无生产后门）。"""
    from app.config import Settings

    with pytest.raises(RuntimeError, match="ACCEPTANCE_TEST_TOKEN"):
        Settings(
            app_mode="real",
            acceptance_test_token="202610",
            database_url="postgresql+psycopg://x/x",
            google_client_id="",
            google_client_secret="",
            google_redirect_uri="",
            email_challenge_hmac_key="k",
            mail_mode="smtp",
            smtp_host="smtp.example",
            mail_from="noreply@example",
            app_origin="https://app.example",
        )
