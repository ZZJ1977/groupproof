from app.config import Settings


def test_database_name_overrides_only_url_path():
    settings = Settings(
        app_mode="dev",
        database_url="postgresql://gp:secret@db.example:5432/railway?sslmode=require",
        database_name="gp_identity",
        email_challenge_hmac_key="test-key",
    )

    assert settings.database_url == "postgresql+psycopg://gp:secret@db.example:5432/gp_identity?sslmode=require"


def test_database_name_rejects_url_path_injection():
    try:
        Settings(
            app_mode="dev",
            database_url="postgresql://gp:secret@db.example:5432/railway",
            database_name="identity/other",
            email_challenge_hmac_key="test-key",
        )
    except ValueError as exc:
        assert "DATABASE_NAME" in str(exc)
    else:
        raise AssertionError("invalid DATABASE_NAME should be rejected")
