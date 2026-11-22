"""Utilitários de segurança, tokens criptográficos, sessões administrativas e auditoria."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import threading
import time
from collections import defaultdict
from datetime import datetime
from functools import wraps

from cryptography.fernet import Fernet, InvalidToken
from flask import g, jsonify, request
from sqlalchemy.orm import Session
from werkzeug.security import check_password_hash, generate_password_hash

from backend.config import MAX_LOGO_BYTES, SESSION_COOKIE_NAME, get_secret_key
from backend.database import SessionLocal
from backend.models import AdminSession, AdminUser, AuditLog, utcnow_naive

_RATE_LOCK = threading.Lock()
_RATE_BUCKETS: dict[str, list[float]] = defaultdict(list)

_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")
_DATA_URL_RE = re.compile(r"^data:(image/(?:png|jpeg|jpg|webp|svg\+xml));base64,([A-Za-z0-9+/=\s]+)$", re.IGNORECASE)


def hash_password(password: str) -> str:
    return generate_password_hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return check_password_hash(password_hash, password)


def generate_secure_token() -> str:
    return secrets.token_urlsafe(32)


def sha256_hex(data: bytes | str) -> str:
    raw = data.encode("utf-8") if isinstance(data, str) else data
    return hashlib.sha256(raw).hexdigest()


def _get_fernet() -> Fernet:
    key_material = hashlib.sha256(get_secret_key().encode("utf-8")).digest()
    fernet_key = base64.urlsafe_b64encode(key_material)
    return Fernet(fernet_key)


def encrypt_token(raw_token: str) -> str:
    return _get_fernet().encrypt(raw_token.encode("utf-8")).decode("ascii")


def decrypt_token(token_encrypted: str) -> str | None:
    if not token_encrypted:
        return None
    try:
        return _get_fernet().decrypt(token_encrypted.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return None


def get_client_ip(req) -> str:
    forwarded = req.headers.get("X-Forwarded-For", "").strip()
    if forwarded:
        return forwarded.split(",")[0].strip()[:80]
    return (req.remote_addr or "")[:80]


def check_rate_limit(bucket_key: str, max_hits: int, window_seconds: int) -> bool:
    """Retorna True se permitido e False se excedeu o limite na janela informada."""
    now = time.monotonic()
    cutoff = now - window_seconds
    with _RATE_LOCK:
        hits = [ts for ts in _RATE_BUCKETS[bucket_key] if ts > cutoff]
        if len(hits) >= max_hits:
            _RATE_BUCKETS[bucket_key] = hits
            return False
        hits.append(now)
        _RATE_BUCKETS[bucket_key] = hits
        return True


def clear_rate_limits() -> None:
    """Limpa buckets em memória (útil para testes automatizados)."""
    with _RATE_LOCK:
        _RATE_BUCKETS.clear()


def is_valid_email(email: str) -> bool:
    return bool(_EMAIL_RE.match((email or "").strip()))


def generate_protocol_code(when: datetime | None = None) -> str:
    dt = when or utcnow_naive()
    alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    suffix = "".join(secrets.choice(alphabet) for _ in range(6))
    return f"LOCAR-{dt.strftime('%Y%m%d')}-{suffix}"


def build_consent_integrity_hash(
    *,
    protocol_code: str,
    city_id: str,
    meeting_id: str,
    meeting_version_id: str,
    pdf_sha256: str,
    representative_name: str,
    representative_email: str,
    accepted_at_iso: str,
    client_ip: str,
) -> str:
    canonical = json.dumps(
        {
            "protocol_code": protocol_code,
            "city_id": city_id,
            "meeting_id": meeting_id,
            "meeting_version_id": meeting_version_id,
            "pdf_sha256": pdf_sha256,
            "representative_name": representative_name,
            "representative_email": representative_email,
            "accepted_at": accepted_at_iso,
            "client_ip": client_ip,
        },
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return sha256_hex(canonical)


def validate_logo_data_url(data_url: str | None) -> tuple[str | None, str | None]:
    """Valida Data URL de imagem para logotipo de cidade (máx. 2 MB)."""
    if data_url is None or str(data_url).strip() == "":
        return None, None

    raw = str(data_url).strip()
    match = _DATA_URL_RE.match(raw)
    if not match:
        raise ValueError("Formato de logotipo inválido. Envie uma imagem PNG, JPG, WEBP ou SVG.")

    mime = match.group(1).lower()
    if mime == "image/jpg":
        mime = "image/jpeg"
    b64_payload = re.sub(r"\s+", "", match.group(2))

    try:
        decoded = base64.b64decode(b64_payload, validate=True)
    except Exception as exc:
        raise ValueError("Imagem de logotipo corrompida (base64 inválido).") from exc

    if len(decoded) == 0:
        raise ValueError("Arquivo de logotipo vazio.")
    if len(decoded) > MAX_LOGO_BYTES:
        raise ValueError("O logotipo da cidade deve ter no máximo 2 MB.")

    if mime == "image/png" and not decoded.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Arquivo PNG inválido para logotipo.")
    if mime == "image/jpeg" and not decoded.startswith(b"\xff\xd8\xff"):
        raise ValueError("Arquivo JPEG inválido para logotipo.")
    if mime == "image/webp" and not (decoded[:4] == b"RIFF" and decoded[8:12] == b"WEBP"):
        raise ValueError("Arquivo WEBP inválido para logotipo.")
    if mime == "image/svg+xml":
        svg_text = decoded.decode("utf-8", errors="ignore").lower()
        if "<svg" not in svg_text:
            raise ValueError("Arquivo SVG inválido para logotipo.")
        if "<script" in svg_text or "javascript:" in svg_text or re.search(r"\bon[a-z]+\s*=", svg_text):
            raise ValueError("SVG contém instruções não permitidas por segurança.")

    normalized = f"data:{mime};base64,{base64.b64encode(decoded).decode('ascii')}"
    return normalized, mime


def sanitize_filename(name: str, fallback: str = "ata_locar.pdf") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.\-]+", "_", (name or "").strip()).strip("._")
    return cleaned or fallback


def log_audit(
    db: Session,
    *,
    event_type: str,
    actor_type: str,
    actor_identifier: str,
    city_id: str | None = None,
    meeting_id: str | None = None,
    meeting_version_id: str | None = None,
    details: dict | None = None,
    ip_address: str = "",
    user_agent: str = "",
) -> AuditLog:
    entry = AuditLog(
        event_type=event_type[:80],
        actor_type=actor_type[:40],
        actor_identifier=actor_identifier[:200],
        city_id=city_id,
        meeting_id=meeting_id,
        meeting_version_id=meeting_version_id,
        details_json=json.dumps(details or {}, ensure_ascii=False),
        ip_address=(ip_address or "")[:80],
        user_agent=(user_agent or "")[:500],
    )
    db.add(entry)
    return entry


def get_authenticated_admin(db: Session) -> tuple[AdminUser | None, AdminSession | None]:
    raw_token = request.cookies.get(SESSION_COOKIE_NAME, "").strip()
    if not raw_token:
        return None, None
    token_hash = sha256_hex(raw_token)
    now = utcnow_naive()
    session_row = (
        db.query(AdminSession)
        .filter(AdminSession.token_hash == token_hash, AdminSession.expires_at > now)
        .first()
    )
    if not session_row:
        return None, None
    user = db.query(AdminUser).filter(AdminUser.id == session_row.user_id, AdminUser.is_active.is_(True)).first()
    if not user:
        return None, None
    return user, session_row


def require_admin(fn):
    """Exige sessão administrativa LOCAR válida nas rotas /api administrativas."""

    @wraps(fn)
    def wrapper(*args, **kwargs):
        db = SessionLocal()
        try:
            user, session_row = get_authenticated_admin(db)
            if not user:
                return jsonify({"error": "Autenticação administrativa necessária."}), 401
            g.db = db
            g.admin_user = user
            g.admin_session = session_row
            return fn(*args, **kwargs)
        finally:
            db.close()

    return wrapper
