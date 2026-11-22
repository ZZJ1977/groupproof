from types import SimpleNamespace

from app.auth.routers.auth import session_payload


def test_active_admin_session_points_to_admin_workspace() -> None:
    context = SimpleNamespace(
        user=SimpleNamespace(
            id="admin-user",
            name="管理员",
            preferred_locale="zh-Hans",
            roles=["admin"],
        ),
        session=SimpleNamespace(
            auth_method="password",
            scope="full",
            csrf_token="csrf-token",
        ),
        facts={
            "accountState": "active",
            "loginEmailVerified": True,
            "identityConfirmed": True,
            "securityComplete": True,
            "requiredCompletedCount": 3,
            "nextAction": {"type": "enter_workspace", "href": "/home"},
        },
    )

    payload = session_payload(context)

    assert payload["nextAction"] == {"type": "enter_admin_workspace", "href": "/admin"}
