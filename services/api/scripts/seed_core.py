from app.db.seed import require_seed_environment, seed_core
from app.db.session import SessionLocal


def main() -> None:
    environment = require_seed_environment()
    with SessionLocal() as session:
        result = seed_core(session, environment=environment)
    for key, value in result.items():
        print(f"{key}={value}")


if __name__ == "__main__":
    main()
