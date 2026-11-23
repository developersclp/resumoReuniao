"""Configurações da aplicação LOCAR (ambiente local e Railway/produção)."""

from __future__ import annotations

import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def get_data_dir() -> Path:
    data_dir = Path(os.environ.get("LOCAR_DATA_DIR", str(BASE_DIR / "data")))
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def get_database_url() -> str:
    # Prioriza DATABASE_URL (padrão oficial Railway/PaaS)
    # com fallback para LOCAR_DATABASE_URL ou DATABASE_PUBLIC_URL.
    url = (
        os.environ.get("DATABASE_URL")
        or os.environ.get("LOCAR_DATABASE_URL")
        or os.environ.get("DATABASE_PUBLIC_URL")
        or ""
    ).strip().strip("'\"")
    if url:
        if url.startswith("postgres://"):
            url = "postgresql+psycopg2://" + url[len("postgres://") :]
        elif url.startswith("postgresql://") and not url.startswith("postgresql+"):
            url = "postgresql+psycopg2://" + url[len("postgresql://") :]
        return url
    db_path = get_data_dir() / "locar_atas.db"
    return f"sqlite:///{db_path.as_posix()}"


def is_production() -> bool:
    return bool(
        os.environ.get("RAILWAY_ENVIRONMENT")
        or os.environ.get("RAILWAY_SERVICE_ID")
        or os.environ.get("DATABASE_URL")
    )


def get_secret_key() -> str:
    env_key = os.environ.get("APP_SECRET_KEY", "").strip()
    if env_key:
        return env_key

    secret_file = get_data_dir() / ".secret_key"
    try:
        if secret_file.exists():
            existing = secret_file.read_text(encoding="utf-8").strip()
            if existing:
                return existing
        generated = secrets.token_urlsafe(48)
        secret_file.write_text(generated, encoding="utf-8")
        return generated
    except OSError:
        return secrets.token_urlsafe(48)


def get_admin_seed_config() -> dict[str, str]:
    return {
        "email": os.environ.get("ADMIN_EMAIL", "admin@locar.srv.br").strip().lower(),
        "password": os.environ.get("ADMIN_PASSWORD", "Locar@2026"),
        "name": os.environ.get("ADMIN_NAME", "Administrador LOCAR").strip() or "Administrador LOCAR",
    }


def get_public_base_url() -> str:
    return os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")


def get_session_ttl_hours() -> int:
    try:
        return max(1, int(os.environ.get("SESSION_TTL_HOURS", "24")))
    except ValueError:
        return 24


def get_default_link_days() -> int:
    try:
        return max(1, min(180, int(os.environ.get("DEFAULT_LINK_DAYS", "30"))))
    except ValueError:
        return 30


MAX_LOGO_BYTES = 2 * 1024 * 1024
SESSION_COOKIE_NAME = "locar_admin_session"
