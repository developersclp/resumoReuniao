"""Conexão e gerenciamento de sessões SQLAlchemy (PostgreSQL no Railway / SQLite local)."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from backend.config import get_database_url


class Base(DeclarativeBase):
    """Base declarativa para os modelos da plataforma Grupo LOCAR."""


def _build_engine(database_url: str | None = None):
    url = database_url or get_database_url()
    is_sqlite = url.startswith("sqlite")
    kwargs: dict = {"future": True}
    if is_sqlite:
        kwargs["connect_args"] = {"check_same_thread": False}
    else:
        kwargs["pool_pre_ping"] = True
        kwargs["pool_recycle"] = 300

    eng = create_engine(url, **kwargs)

    if is_sqlite:
        @event.listens_for(eng, "connect")
        def _set_sqlite_pragmas(dbapi_connection, _connection_record):
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON;")
            cursor.execute("PRAGMA journal_mode=WAL;")
            cursor.execute("PRAGMA busy_timeout=5000;")
            cursor.close()

    return eng


engine = _build_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def reconfigure_engine(database_url: str) -> None:
    """Permite reconfigurar o banco em testes isolados."""
    global engine, SessionLocal
    engine.dispose()
    engine = _build_engine(database_url)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def init_db() -> None:
    """Cria as tabelas caso ainda não existam."""
    from backend import models  # noqa: F401

    Base.metadata.create_all(bind=engine)


@contextmanager
def db_session() -> Iterator[Session]:
    """Context manager seguro para operações de banco."""
    session = SessionLocal()
    try:
        yield session
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def check_db_health() -> tuple[bool, str]:
    """Verifica conectividade com o banco de dados e informa o dialeto ativo."""
    dialect = engine.dialect.name
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True, dialect
    except Exception:
        return False, dialect
