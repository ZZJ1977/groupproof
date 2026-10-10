from app.db.seed import seed_core
from app.db.session import SessionLocal


def main() -> None:
    with SessionLocal() as session:
        result = seed_core(session)
    for key, value in result.items():
        print(f"{key}={value}")


if __name__ == "__main__":
    main()
