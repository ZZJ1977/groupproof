from pathlib import Path

from packaging.requirements import Requirement
from packaging.version import Version


def test_worker_pins_celery_kombu_redis_compatible_versions():
    for rel in (
        Path(__file__).parents[1] / "requirements.txt",
        Path(__file__).parents[2] / "api" / "requirements.txt",
    ):
        parsed = {
            requirement.name.lower(): requirement
            for requirement in (
                Requirement(line.strip())
                for line in rel.read_text().splitlines()
                if line.strip() and not line.lstrip().startswith("#")
            )
        }

        # Kombu 5.6 performs a runtime check for redis-py >= 6.1, while Celery 5.4
        # declares redis-py < 6. Pin the last compatible Kombu release explicitly.
        assert Version("5.5.4") in parsed["kombu"].specifier
        assert Version("5.6.0") not in parsed["kombu"].specifier
        assert Version("5.2.1") in parsed["redis"].specifier
