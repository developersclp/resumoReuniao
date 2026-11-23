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


def get_database_url_candidates() -> list[str]:
    """Retorna lista de URLs de banco de dados candidatas para conexão resiliente."""
    raw_list: list[str] = []

    # 1. DATABASE_URL do ambiente
    db_env = os.environ.get("DATABASE_URL", "").strip().strip("'\"")
    if db_env:
        raw_list.append(db_env)

    # 2. LOCAR_DATABASE_URL do ambiente
    locar_env = os.environ.get("LOCAR_DATABASE_URL", "").strip().strip("'\"")
    if locar_env and locar_env not in raw_list:
        raw_list.append(locar_env)

    # 3. DATABASE_PUBLIC_URL do ambiente
    pub_env = os.environ.get("DATABASE_PUBLIC_URL", "").strip().strip("'\"")
    if pub_env and pub_env not in raw_list:
        raw_list.append(pub_env)

    # 4. Fallback no Railway com credencial informada
    if is_production():
        railway_internal = "postgresql://postgres:JiFnNjDHMgDNQoxWxHVGoPXDQOBsLzmC@postgres.railway.internal:5432/railway"
        if railway_internal not in raw_list:
            raw_list.append(railway_internal)

    normalized: list[str] = []
    for u in raw_list:
        if u.startswith("DATABASE_URL="):
            u = u.split("=", 1)[1].strip().strip("'\"")
        if u.startswith("postgres://"):
            u = "postgresql+psycopg2://" + u[len("postgres://") :]
        elif u.startswith("postgresql://") and not u.startswith("postgresql+"):
            u = "postgresql+psycopg2://" + u[len("postgresql://") :]
        if u and u not in normalized:
            normalized.append(u)
    return normalized


def get_database_url() -> str:
    candidates = get_database_url_candidates()
    if candidates:
        return candidates[0]
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
