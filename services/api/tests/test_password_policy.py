"""New passwords require only eight characters; existing hashes remain compatible."""

import pytest

from app.auth.security import (
    hash_password,
    hash_password_legacy,
    validate_password,
    verify_password,
)


@pytest.mark.parametrize("password", ["", "1234567", "密" * 7])
def test_password_rejects_fewer_than_eight_characters(password: str) -> None:
    with pytest.raises(ValueError, match="^password_policy$"):
        validate_password(password)


@pytest.mark.parametrize(
    "password",
    ["12345678", "password", "aaaaaaaa", " " * 8, "密" * 8, "🙂" * 8, "a" * 129, "a" * 512],
)
def test_password_accepts_eight_or_more_characters_without_other_restrictions(
    password: str,
) -> None:
    assert validate_password(password) == password


def test_long_unicode_password_round_trips_without_truncation() -> None:
    password = "学校邮箱密码" * 30
    encoded = hash_password(validate_password(password))
    assert encoded.startswith("$argon2id$")
    assert verify_password(password, encoded)
    assert not verify_password(password[:-1], encoded)


def test_existing_bcrypt_password_still_verifies() -> None:
    encoded = hash_password_legacy("legacy42")
    assert verify_password("legacy42", encoded)
    assert not verify_password("different42", encoded)
