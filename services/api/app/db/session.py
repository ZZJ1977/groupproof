from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session, sessionmaker

from app.db.settings import get_database_timezone, get_database_url

DATABASE_TIMEZONE = get_database_timezone()

engine = create_engine(get_database_url(), pool_pre_ping=True)


@event.listens_for(engine, "connect")
def set_connection_timezone(dbapi_connection: object, _connection_record: object) -> None:
    """Keep PostgreSQL timestamp rendering and CURRENT_TIMESTAMP in Beijing time."""

    previous_autocommit = dbapi_connection.autocommit  # type: ignore[attr-defined]
    dbapi_connection.autocommit = True  # type: ignore[attr-defined]
    try:
        cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
        cursor.execute(f"SET TIME ZONE '{DATABASE_TIMEZONE}'")
        cursor.close()
    finally:
        dbapi_connection.autocommit = previous_autocommit  # type: ignore[attr-defined]


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def get_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def check_database_timezone(session: Session) -> str:
    return str(session.execute(text("SHOW TIME ZONE")).scalar_one())
