"""数据库访问：统一走团队 app.db.session 的引擎/会话工厂（单库、单一迁移链）。

get_db 保留独立 server/ 的事务语义：请求成功提交、异常回滚。
"""

from __future__ import annotations

from collections.abc import Generator

from sqlalchemy.orm import Session

from app.db.session import SessionLocal


def get_engine():
    from app.db.session import engine

    return engine


def get_session_factory():
    return SessionLocal


def reset_engine() -> None:
    """兼容旧测试钩子：团队引擎在模块加载时创建，不重建。"""


def get_db() -> Generator[Session, None, None]:
    """FastAPI 依赖：每个请求独立事务边界；异常自动回滚。"""
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
