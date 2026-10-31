import pytest

from app.db.seed import SeedEnvironmentError, require_seed_environment


@pytest.mark.parametrize("environment", ["development", "test"])
def test_seed_allows_non_production_environments(
    environment: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("APP_ENV", environment)
    assert require_seed_environment(environment) == environment


@pytest.mark.parametrize("environment", [None, "staging", "production", "qa"])
def test_seed_rejects_unknown_or_production_environments(
    environment: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    if environment is None:
        monkeypatch.delenv("APP_ENV", raising=False)
    with pytest.raises(SeedEnvironmentError):
        require_seed_environment(environment)


def test_seed_rejects_explicit_environment_that_disagrees_with_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(SeedEnvironmentError):
        require_seed_environment("test")
