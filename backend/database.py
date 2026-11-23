"""Conexão e gerenciamento de sessões SQLAlchemy (PostgreSQL no Railway / SQLite local)."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, event, inspect, text
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


def _ensure_schema_columns(conn) -> None:
    """Adiciona colunas novas de forma idempotente em bancos SQLite/PostgreSQL existentes."""
    inspector = inspect(conn)
    table_names = set(inspector.get_table_names())
    migrations = {
        "cities": [
            ("default_primary_color", "VARCHAR(20) NOT NULL DEFAULT '#0a7e3a'"),
            ("default_secondary_color", "VARCHAR(20) NOT NULL DEFAULT '#b4c85a'"),
            ("report_logo_data_url", "TEXT"),
        ],
        "meetings": [
            ("primary_color", "VARCHAR(20) NOT NULL DEFAULT '#0a7e3a'"),
            ("secondary_color", "VARCHAR(20) NOT NULL DEFAULT '#b4c85a'"),
            ("report_logo_data_url", "TEXT"),
        ],
    }
    for table_name, columns in migrations.items():
        if table_name not in table_names:
            continue
        existing = {col["name"] for col in inspector.get_columns(table_name)}
        for col_name, col_ddl in columns:
            if col_name not in existing:
                conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {col_name} {col_ddl}"))


def init_db() -> None:
    """Cria as tabelas caso ainda não existam e garante migrações incrementais."""
    from backend import models  # noqa: F401
    from sqlalchemy.exc import IntegrityError, ProgrammingError

    is_sqlite = engine.url.drivername.startswith("sqlite")
    if not is_sqlite:
        with engine.connect() as conn:
            conn.execute(text("SELECT pg_advisory_lock(847291038);"))
            try:
                Base.metadata.create_all(bind=conn)
                _ensure_schema_columns(conn)
                conn.commit()
            except (IntegrityError, ProgrammingError) as exc:
                conn.rollback()
                err_str = str(exc).lower()
                if "already exists" in err_str or "unique constraint" in err_str or "pg_type" in err_str:
                    _ensure_schema_columns(conn)
                    conn.commit()
                else:
                    raise
            finally:
                conn.execute(text("SELECT pg_advisory_unlock(847291038);"))
                conn.commit()
    else:
        Base.metadata.create_all(bind=engine)
        with engine.connect() as conn:
            _ensure_schema_columns(conn)
            conn.commit()


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
