"""Rotas administrativas protegidas por sessão LOCAR (cidades, reuniões, versões, links e auditoria)."""

from __future__ import annotations

import json
import re
from datetime import timedelta

from flask import Blueprint, Response, g, jsonify, request
from sqlalchemy import desc
from sqlalchemy.orm import Session

from backend.config import (
    SESSION_COOKIE_NAME,
    get_default_link_days,
    get_public_base_url,
    get_session_ttl_hours,
    is_production,
)
from backend.database import SessionLocal
from backend.models import (
    WORKFLOW_LABELS,
    ActionItem,
    AdminSession,
    AdminUser,
    AuditLog,
    City,
    ConsentRecord,
    Meeting,
    MeetingIndicator,
    MeetingVersion,
    PublicLink,
    iso_utc,
    utcnow_naive,
)
from backend.pdf_generator import render_meeting_pdf
from backend.security import (
    check_rate_limit,
    decrypt_token,
    encrypt_token,
    generate_secure_token,
    get_authenticated_admin,
    get_client_ip,
    hash_password,
    is_valid_email,
    log_audit,
    require_admin,
    sanitize_filename,
    sha256_hex,
    validate_logo_data_url,
    verify_password,
)

admin_bp = Blueprint("admin_api", __name__, url_prefix="/api")

ALLOWED_WORKFLOW_STATUSES = {
    "rascunho",
    "aguardando_envio",
    "link_enviado",
    "aguardando_confirmacao",
    "confirmada",
    "link_invalido",
}
ALLOWED_TRACKING_STATUSES = {"pendente", "em_andamento", "concluida", "nao_realizada"}
_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _normalize_hex_color(value: str | None, default: str) -> str:
    raw = str(value or "").strip()
    if not _HEX_COLOR_RE.match(raw):
        return default
    if len(raw) == 4:
        return "#" + "".join(ch * 2 for ch in raw[1:]).lower()
    return raw.lower()


def _slugify(value: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return base or "cidade"


def _unique_city_slug(db: Session, name: str, exclude_id: str | None = None) -> str:
    base = _slugify(name)
    candidate = base
    idx = 2
    while True:
        q = db.query(City).filter(City.slug == candidate)
        if exclude_id:
            q = q.filter(City.id != exclude_id)
        if not q.first():
            return candidate
        candidate = f"{base}-{idx}"
        idx += 1


def _build_public_url(raw_token: str) -> str:
    base = get_public_base_url()
    if not base:
        base = request.url_root.rstrip("/")
    return f"{base}/ata/{raw_token}"


def sync_expired_links_for_meeting(db: Session, meeting: Meeting) -> bool:
    """Atualiza links expirados e situação da reunião se necessário. Retorna True se houve alteração."""
    now = utcnow_naive()
    changed = False
    active_links = (
        db.query(PublicLink)
        .filter(PublicLink.meeting_id == meeting.id, PublicLink.status == "active")
        .all()
    )
    for link in active_links:
        if link.expires_at <= now:
            link.status = "expired"
            changed = True
            log_audit(
                db,
                event_type="public_link_expired",
                actor_type="system",
                actor_identifier="system",
                city_id=meeting.city_id,
                meeting_id=meeting.id,
                meeting_version_id=link.meeting_version_id,
                details={"link_id": link.id},
            )
    if changed and meeting.workflow_status in ("link_enviado", "aguardando_confirmacao"):
        meeting.workflow_status = "link_invalido"
    if changed:
        db.commit()
    return changed


def _workflow_label(status: str) -> str:
    return WORKFLOW_LABELS.get(status, WORKFLOW_LABELS["aguardando_envio"])


def _find_previous_meeting(db: Session, meeting: Meeting) -> Meeting | None:
    """Localiza a reunião anterior da mesma cidade/projeto para acompanhamento e importação de pendências."""
    candidates = (
        db.query(Meeting)
        .filter(Meeting.city_id == meeting.city_id, Meeting.id != meeting.id)
        .order_by(desc(Meeting.meeting_date), desc(Meeting.created_at))
        .all()
    )
    if not candidates:
        return None
    cur_key = (meeting.meeting_date or "", meeting.created_at)
    for cand in candidates:
        cand_key = (cand.meeting_date or "", cand.created_at)
        if cand_key < cur_key:
            return cand
    return candidates[0]


def _serialize_link_admin(link: PublicLink) -> dict:
    raw_token = decrypt_token(link.token_encrypted) if link.status == "active" else None
    return {
        "id": link.id,
        "city_id": link.city_id,
        "meeting_id": link.meeting_id,
        "meeting_version_id": link.meeting_version_id,
        "version_number": link.version.version_number if link.version else None,
        "status": link.status,
        "public_url": _build_public_url(raw_token) if raw_token else None,
        "expires_at": iso_utc(link.expires_at),
        "view_count": link.view_count,
        "first_viewed_at": iso_utc(link.first_viewed_at),
        "last_viewed_at": iso_utc(link.last_viewed_at),
        "pdf_viewed_at": iso_utc(link.pdf_viewed_at),
        "pdf_downloaded_at": iso_utc(link.pdf_downloaded_at),
        "created_by_name": link.created_by_name,
        "created_at": iso_utc(link.created_at),
        "revoked_at": iso_utc(link.revoked_at),
        "revoked_by_name": link.revoked_by_name,
        "revoke_reason": link.revoke_reason,
        "used_at": iso_utc(link.used_at),
    }


def _serialize_meeting_summary(db: Session, meeting: Meeting) -> dict:
    sync_expired_links_for_meeting(db, meeting)
    latest_consent = meeting.consents[0] if meeting.consents else None
    active_link = next((l for l in meeting.public_links if l.status == "active"), None)
    total_actions = len(meeting.actions)
    completed_actions = sum(1 for a in meeting.actions if a.checked_completed)
    return {
        "id": meeting.id,
        "city_id": meeting.city_id,
        "reference_month": meeting.reference_month,
        "reference_label": meeting.reference_label,
        "meeting_date": meeting.meeting_date,
        "date_text": meeting.date_text,
        "time_text": meeting.time_text,
        "title": meeting.title,
        "workflow_status": meeting.workflow_status,
        "workflow_label": _workflow_label(meeting.workflow_status),
        "is_draft": meeting.current_version_number == 0,
        "has_frozen_pdf": meeting.current_version_number > 0,
        "current_version_number": meeting.current_version_number,
        "is_locked": bool(meeting.is_locked),
        "total_actions": total_actions,
        "completed_actions": completed_actions,
        "pending_actions": max(0, total_actions - completed_actions),
        "total_indicators": len(meeting.indicators),
        "active_link": _serialize_link_admin(active_link) if active_link else None,
        "latest_consent": latest_consent.to_dict() if latest_consent else None,
        "created_at": iso_utc(meeting.created_at),
        "updated_at": iso_utc(meeting.updated_at),
    }


def _serialize_meeting_full(db: Session, meeting: Meeting) -> dict:
    sync_expired_links_for_meeting(db, meeting)
    city = meeting.city
    active_link = next((l for l in meeting.public_links if l.status == "active"), None)
    latest_version = next((v for v in meeting.versions if v.is_current), None)
    prev = _find_previous_meeting(db, meeting)
    audit_rows = (
        db.query(AuditLog)
        .filter(AuditLog.meeting_id == meeting.id)
        .order_by(desc(AuditLog.created_at))
        .limit(60)
        .all()
    )

    prev_payload = None
    if prev:
        prev_payload = {
            "id": prev.id,
            "title": prev.title,
            "reference_label": prev.reference_label,
            "meeting_date": prev.meeting_date,
            "date_text": prev.date_text,
            "workflow_status": prev.workflow_status,
            "workflow_label": _workflow_label(prev.workflow_status),
            "indicators": [ind.to_dict() for ind in prev.indicators],
            "actions": [act.to_dict() for act in prev.actions],
        }

    return {
        "meeting": {
            "id": meeting.id,
            "city_id": meeting.city_id,
            "workflow_status": meeting.workflow_status,
            "workflow_label": _workflow_label(meeting.workflow_status),
            "is_draft": meeting.current_version_number == 0,
            "has_frozen_pdf": meeting.current_version_number > 0,
            "current_version_number": meeting.current_version_number,
            "is_locked": bool(meeting.is_locked),
            "created_at": iso_utc(meeting.created_at),
            "updated_at": iso_utc(meeting.updated_at),
            "snapshot": meeting.to_editor_snapshot(),
        },
        "city": city.to_dict(include_logo=True) if city else None,
        "current_version": latest_version.to_metadata_dict() if latest_version else None,
        "versions": [v.to_metadata_dict() for v in meeting.versions],
        "active_link": _serialize_link_admin(active_link) if active_link else None,
        "links": [_serialize_link_admin(l) for l in meeting.public_links],
        "consents": [c.to_dict() for c in meeting.consents],
        "audit_logs": [a.to_dict() for a in audit_rows],
        "previous_meeting": prev_payload,
    }


def _apply_meeting_payload(db: Session, meeting: Meeting, payload: dict) -> None:
    """Aplica atualizações do editor A4 ao rascunho/versão em edição, preservando tracking das ações."""
    if "referenceMonth" in payload or "reference_month" in payload:
        meeting.reference_month = str(
            payload.get("referenceMonth") if "referenceMonth" in payload else payload.get("reference_month") or ""
        )[:20]
    if "referenceLabel" in payload or "reference_label" in payload:
        meeting.reference_label = str(
            payload.get("referenceLabel") if "referenceLabel" in payload else payload.get("reference_label") or ""
        )[:80]
    if "meetingDate" in payload or "meeting_date" in payload:
        meeting.meeting_date = str(
            payload.get("meetingDate") if "meetingDate" in payload else payload.get("meeting_date") or ""
        )[:20]

    field_map = {
        "unitName": ("unit_name_display", 200),
        "local": ("local", 180),
        "dateText": ("date_text", 120),
        "timeText": ("time_text", 40),
        "participants": ("participants", 10000),
        "title": ("title", 255),
        "summary": ("summary", 20000),
        "headerTheme": ("header_theme", 20),
        "densityMode": ("density_mode", 20),
        "footerText": ("footer_text", 220),
    }
    for json_key, (attr, max_len) in field_map.items():
        if json_key in payload:
            setattr(meeting, attr, str(payload.get(json_key) or "")[:max_len])

    if "showTopics" in payload:
        meeting.show_topics = bool(payload.get("showTopics"))
    if "topics" in payload:
        meeting.set_topics(payload.get("topics") or [])
    if "showKpisOnSheet" in payload:
        meeting.show_kpis_on_sheet = bool(payload.get("showKpisOnSheet"))
    if "primaryColor" in payload:
        color = _normalize_hex_color(payload.get("primaryColor"), "#0a7e3a")
        meeting.primary_color = color
        if meeting.city:
            meeting.city.default_primary_color = color
    if "secondaryColor" in payload:
        color = _normalize_hex_color(payload.get("secondaryColor"), "#b4c85a")
        meeting.secondary_color = color
        if meeting.city:
            meeting.city.default_secondary_color = color
    if "reportLogoDataUrl" in payload:
        raw_report_logo = str(payload.get("reportLogoDataUrl") or "").strip()
        if raw_report_logo == "":
            meeting.report_logo_data_url = None
            if meeting.city:
                meeting.city.report_logo_data_url = None
        else:
            validated_url, _ = validate_logo_data_url(raw_report_logo)
            meeting.report_logo_data_url = validated_url
            if meeting.city:
                meeting.city.report_logo_data_url = validated_url
    if "cityLogoDataUrl" in payload and meeting.city:
        raw_city_logo = str(payload.get("cityLogoDataUrl") or "").strip()
        if raw_city_logo == "":
            meeting.city.logo_data_url = None
            meeting.city.logo_mime_type = None
        else:
            validated_url, validated_mime = validate_logo_data_url(raw_city_logo)
            meeting.city.logo_data_url = validated_url
            meeting.city.logo_mime_type = validated_mime
    if "extraBlankRows" in payload:
        try:
            meeting.extra_blank_rows = max(0, min(6, int(payload.get("extraBlankRows") or 0)))
        except (TypeError, ValueError):
            meeting.extra_blank_rows = 1

    if "indicators" in payload and isinstance(payload.get("indicators"), list):
        db.query(MeetingIndicator).filter(MeetingIndicator.meeting_id == meeting.id).delete()
        for idx, ind in enumerate(payload["indicators"]):
            if not isinstance(ind, dict):
                continue
            status = str(ind.get("status") or "ok").lower()
            if status not in ("ok", "warn", "danger"):
                status = "ok"
            db.add(
                MeetingIndicator(
                    meeting_id=meeting.id,
                    city_id=meeting.city_id,
                    label=str(ind.get("label") or "")[:160],
                    value=str(ind.get("value") or "")[:200],
                    status=status,
                    sort_order=idx,
                )
            )

    if "actions" in payload and isinstance(payload.get("actions"), list):
        existing_map = {a.id: a for a in meeting.actions}
        kept_ids: set[str] = set()
        for idx, act in enumerate(payload["actions"]):
            if not isinstance(act, dict):
                continue
            act_id = str(act.get("id") or "").strip()
            existing = existing_map.get(act_id) if act_id else None
            if existing:
                existing.action_text = str(act.get("action") or "")
                existing.owner = str(act.get("owner") or "")[:255]
                existing.deadline = str(act.get("deadline") or "")[:160]
                existing.status_text = str(act.get("status") or "")[:160]
                existing.sort_order = idx
                kept_ids.add(existing.id)
            else:
                tracking = str(act.get("tracking_status") or "pendente")
                if tracking not in ALLOWED_TRACKING_STATUSES:
                    tracking = "pendente"
                new_item = ActionItem(
                    meeting_id=meeting.id,
                    city_id=meeting.city_id,
                    origin_action_id=act.get("origin_action_id"),
                    action_text=str(act.get("action") or ""),
                    owner=str(act.get("owner") or "")[:255],
                    deadline=str(act.get("deadline") or "")[:160],
                    status_text=str(act.get("status") or "")[:160],
                    tracking_status=tracking,
                    checked_completed=bool(act.get("checked_completed", False)),
                    follow_up_notes=str(act.get("follow_up_notes") or ""),
                    sort_order=idx,
                )
                db.add(new_item)
                db.flush()
                kept_ids.add(new_item.id)

        for old_id, old_obj in existing_map.items():
            if old_id not in kept_ids:
                db.delete(old_obj)


# -------------------- Autenticação Administrativa LOCAR --------------------


@admin_bp.route("/auth/login", methods=["POST"])
def auth_login():
    ip = get_client_ip(request)
    if not check_rate_limit(f"admin_login:{ip}", max_hits=12, window_seconds=300):
        return jsonify({"error": "Muitas tentativas de login. Aguarde alguns minutos."}), 429

    data = request.get_json(silent=True) or {}
    email = str(data.get("email") or "").strip().lower()
    password = str(data.get("password") or "")
    if not email or not password:
        return jsonify({"error": "Informe e-mail e senha administrativos."}), 400

    db = SessionLocal()
    try:
        user = db.query(AdminUser).filter(AdminUser.email == email).first()
        if not user or not user.is_active or not verify_password(password, user.password_hash):
            log_audit(
                db,
                event_type="admin_login_failed",
                actor_type="anonymous",
                actor_identifier=email or "unknown",
                details={"reason": "invalid_credentials"},
                ip_address=ip,
                user_agent=request.headers.get("User-Agent", ""),
            )
            db.commit()
            return jsonify({"error": "E-mail ou senha inválidos."}), 401

        raw_token = generate_secure_token()
        ttl_hours = get_session_ttl_hours()
        expires_at = utcnow_naive() + timedelta(hours=ttl_hours)
        session_row = AdminSession(
            user_id=user.id,
            token_hash=sha256_hex(raw_token),
            ip_address=ip,
            user_agent=request.headers.get("User-Agent", "")[:500],
            expires_at=expires_at,
        )
        db.add(session_row)
        log_audit(
            db,
            event_type="admin_login",
            actor_type="admin",
            actor_identifier=user.email,
            details={"user_id": user.id},
            ip_address=ip,
            user_agent=request.headers.get("User-Agent", ""),
        )
        db.commit()

        resp = jsonify({"authenticated": True, "user": user.to_dict()})
        resp.set_cookie(
            SESSION_COOKIE_NAME,
            raw_token,
            max_age=ttl_hours * 3600,
            httponly=True,
            samesite="Lax",
            secure=is_production(),
            path="/",
        )
        return resp, 200
    finally:
        db.close()


@admin_bp.route("/auth/logout", methods=["POST"])
def auth_logout():
    db = SessionLocal()
    try:
        user, session_row = get_authenticated_admin(db)
        if session_row:
            db.delete(session_row)
        if user:
            log_audit(
                db,
                event_type="admin_logout",
                actor_type="admin",
                actor_identifier=user.email,
                ip_address=get_client_ip(request),
                user_agent=request.headers.get("User-Agent", ""),
            )
        db.commit()
        resp = jsonify({"authenticated": False})
        resp.delete_cookie(SESSION_COOKIE_NAME, path="/")
        return resp, 200
    finally:
        db.close()


@admin_bp.route("/auth/me", methods=["GET"])
def auth_me():
    db = SessionLocal()
    try:
        user, _ = get_authenticated_admin(db)
        if not user:
            return jsonify({"authenticated": False}), 401
        return jsonify({"authenticated": True, "user": user.to_dict()}), 200
    finally:
        db.close()


@admin_bp.route("/auth/change-password", methods=["POST"])
@require_admin
def auth_change_password():
    data = request.get_json(silent=True) or {}
    current_pw = str(data.get("current_password") or "")
    new_pw = str(data.get("new_password") or "")
    if not verify_password(current_pw, g.admin_user.password_hash):
        return jsonify({"error": "Senha atual incorreta."}), 400
    if len(new_pw) < 8:
        return jsonify({"error": "A nova senha deve ter pelo menos 8 caracteres."}), 400

    g.admin_user.password_hash = hash_password(new_pw)
    log_audit(
        g.db,
        event_type="admin_password_changed",
        actor_type="admin",
        actor_identifier=g.admin_user.email,
        ip_address=get_client_ip(request),
        user_agent=request.headers.get("User-Agent", ""),
    )
    g.db.commit()
    return jsonify({"ok": True, "message": "Senha alterada com sucesso."}), 200


@admin_bp.route("/admin/users", methods=["GET"])
@require_admin
def list_admin_users():
    users = g.db.query(AdminUser).order_by(AdminUser.created_at).all()
    return jsonify({"users": [u.to_dict() for u in users]}), 200


@admin_bp.route("/admin/users", methods=["POST"])
@require_admin
def create_admin_user():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    email = str(data.get("email") or "").strip().lower()
    password = str(data.get("password") or "")
    if len(name) < 2:
        return jsonify({"error": "Informe o nome do administrador."}), 400
    if not is_valid_email(email):
        return jsonify({"error": "Informe um e-mail válido."}), 400
    if len(password) < 8:
        return jsonify({"error": "A senha deve ter no mínimo 8 caracteres."}), 400
    if g.db.query(AdminUser).filter(AdminUser.email == email).first():
        return jsonify({"error": "Já existe um administrador cadastrado com este e-mail."}), 409

    new_user = AdminUser(
        name=name[:160],
        email=email[:200],
        password_hash=hash_password(password),
        role="admin",
        is_active=True,
    )
    g.db.add(new_user)
    g.db.flush()
    log_audit(
        g.db,
        event_type="admin_user_created",
        actor_type="admin",
        actor_identifier=g.admin_user.email,
        details={"created_email": new_user.email, "created_id": new_user.id},
        ip_address=get_client_ip(request),
        user_agent=request.headers.get("User-Agent", ""),
    )
    g.db.commit()
    return jsonify({"user": new_user.to_dict()}), 201


@admin_bp.route("/admin/users/<user_id>", methods=["PATCH"])
@require_admin
def update_admin_user(user_id: str):
    target = g.db.query(AdminUser).filter(AdminUser.id == user_id).first()
    if not target:
        return jsonify({"error": "Administrador não encontrado."}), 404
    data = request.get_json(silent=True) or {}
    if "is_active" in data:
        want_active = bool(data.get("is_active"))
        if target.id == g.admin_user.id and not want_active:
            return jsonify({"error": "Não é possível desativar sua própria conta ativa."}), 400
        target.is_active = want_active
    if "name" in data and str(data.get("name") or "").strip():
        target.name = str(data.get("name")).strip()[:160]
    if "password" in data and str(data.get("password") or ""):
        pw = str(data.get("password"))
        if len(pw) < 8:
            return jsonify({"error": "A nova senha deve ter no mínimo 8 caracteres."}), 400
        target.password_hash = hash_password(pw)

    log_audit(
        g.db,
        event_type="admin_user_updated",
        actor_type="admin",
        actor_identifier=g.admin_user.email,
        details={"target_email": target.email, "is_active": target.is_active},
        ip_address=get_client_ip(request),
        user_agent=request.headers.get("User-Agent", ""),
    )
    g.db.commit()
    return jsonify({"user": target.to_dict()}), 200


# -------------------- Dashboard Geral do Grupo LOCAR --------------------


def _normalize_action_text(text: str | None) -> str:
    return " ".join((text or "").strip().lower().split())


def _iter_consolidated_city_actions(meetings: list[Meeting]):
    """Retorna ações consolidadas da cidade da reunião mais recente p/ a mais antiga, sem duplicar pendências herdadas."""
    superseded_ids = {
        act.origin_action_id
        for mt in meetings
        for act in mt.actions
        if act.origin_action_id
    }
    seen_pending_texts: set[str] = set()
    consolidated: list[tuple[Meeting, ActionItem]] = []
    for mt in meetings:
        for act in mt.actions:
            if act.id in superseded_ids:
                continue
            norm_text = _normalize_action_text(act.action_text)
            if not act.checked_completed and norm_text:
                if norm_text in seen_pending_texts:
                    continue
                seen_pending_texts.add(norm_text)
            consolidated.append((mt, act))
    return consolidated


@admin_bp.route("/dashboard", methods=["GET"])
@require_admin
def get_dashboard():
    cities = g.db.query(City).order_by(City.display_order, City.name).all()
    status_counts = {
        "aguardando_envio": 0,
        "link_enviado": 0,
        "aguardando_confirmacao": 0,
        "confirmada": 0,
        "link_invalido": 0,
    }
    total_meetings = 0
    pending_actions_total = 0
    completed_actions_total = 0
    city_cards = []

    for city in cities:
        meetings = list(city.meetings)
        total_meetings += len(meetings)
        latest = meetings[0] if meetings else None
        latest_summary = _serialize_meeting_summary(g.db, latest) if latest else None

        for mt in meetings:
            sync_expired_links_for_meeting(g.db, mt)
            bucket = "aguardando_envio" if mt.workflow_status == "rascunho" else mt.workflow_status
            if bucket in status_counts:
                status_counts[bucket] += 1

        city_pending = 0
        city_completed = 0
        for _mt, act in _iter_consolidated_city_actions(meetings):
            if act.checked_completed:
                city_completed += 1
            else:
                city_pending += 1

        pending_actions_total += city_pending
        completed_actions_total += city_completed

        city_cards.append(
            {
                "city": city.to_dict(include_logo=True),
                "meetings_count": len(meetings),
                "pending_actions": city_pending,
                "completed_actions": city_completed,
                "latest_meeting": latest_summary,
            }
        )

    return (
        jsonify(
            {
                "summary": {
                    "total_cities": len(cities),
                    "active_cities": sum(1 for c in cities if c.is_active),
                    "total_meetings": total_meetings,
                    "status_counts": status_counts,
                    "pending_actions_total": pending_actions_total,
                    "completed_actions_total": completed_actions_total,
                },
                "cities": city_cards,
            }
        ),
        200,
    )


# -------------------- Gerenciamento das 12 Cidades / Projetos --------------------


@admin_bp.route("/cities", methods=["GET"])
@require_admin
def list_cities():
    cities = g.db.query(City).order_by(City.display_order, City.name).all()
    result = []
    for city in cities:
        latest = city.meetings[0] if city.meetings else None
        item = city.to_dict(include_logo=True)
        item["meetings_count"] = len(city.meetings)
        item["latest_meeting"] = _serialize_meeting_summary(g.db, latest) if latest else None
        result.append(item)
    return jsonify({"cities": result}), 200


@admin_bp.route("/cities", methods=["POST"])
@require_admin
def create_city():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    project_name = str(data.get("project_name") or "").strip() or f"Projeto de Limpeza Urbana — {name}"
    if len(name) < 2:
        return jsonify({"error": "Informe o nome da cidade."}), 400

    try:
        logo_url, logo_mime = validate_logo_data_url(data.get("logo_data_url"))
        report_logo_url, _ = validate_logo_data_url(data.get("report_logo_data_url"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    max_order = g.db.query(City).count()
    city = City(
        slug=_unique_city_slug(g.db, name),
        name=name[:180],
        project_name=project_name[:220],
        project_code=str(data.get("project_code") or f"LOCAR-{max_order + 1:02d}")[:40],
        state_uf=str(data.get("state_uf") or "PE")[:10].upper(),
        logo_data_url=logo_url,
        logo_mime_type=logo_mime,
        default_primary_color=_normalize_hex_color(data.get("default_primary_color"), "#0a7e3a"),
        default_secondary_color=_normalize_hex_color(data.get("default_secondary_color"), "#b4c85a"),
        report_logo_data_url=report_logo_url,
        institutional_info=str(data.get("institutional_info") or ""),
        default_local=str(data.get("default_local") or "Microsoft Teams")[:180],
        default_footer=str(data.get("default_footer") or "DIE – Departamento de Inteligência Estratégica")[:220],
        display_order=int(data.get("display_order") or (max_order + 1)),
        is_active=bool(data.get("is_active", True)),
    )
    g.db.add(city)
    g.db.flush()
    log_audit(
        g.db,
        event_type="city_created",
        actor_type="admin",
        actor_identifier=g.admin_user.email,
        city_id=city.id,
        details={"name": city.name, "project_name": city.project_name},
        ip_address=get_client_ip(request),
        user_agent=request.headers.get("User-Agent", ""),
    )
    g.db.commit()
    return jsonify({"city": city.to_dict(include_logo=True)}), 201


@admin_bp.route("/cities/<city_id>", methods=["GET"])
@require_admin
def get_city(city_id: str):
    city = g.db.query(City).filter(City.id == city_id).first()
    if not city:
        return jsonify({"error": "Cidade/projeto não encontrado."}), 404
    return jsonify({"city": city.to_dict(include_logo=True)}), 200


@admin_bp.route("/cities/<city_id>", methods=["PUT"])
@require_admin
def update_city(city_id: str):
    city = g.db.query(City).filter(City.id == city_id).first()
    if not city:
        return jsonify({"error": "Cidade/projeto não encontrado."}), 404

    data = request.get_json(silent=True) or {}
    if "name" in data:
        new_name = str(data.get("name") or "").strip()
        if len(new_name) < 2:
            return jsonify({"error": "O nome da cidade deve ter pelo menos 2 caracteres."}), 400
        city.name = new_name[:180]
        city.slug = _unique_city_slug(g.db, new_name, exclude_id=city.id)
    if "project_name" in data:
        city.project_name = str(data.get("project_name") or city.name).strip()[:220]
    if "project_code" in data:
        city.project_code = str(data.get("project_code") or "").strip()[:40]
    if "state_uf" in data:
        city.state_uf = str(data.get("state_uf") or "").strip().upper()[:10]
    if "institutional_info" in data:
        city.institutional_info = str(data.get("institutional_info") or "")
    if "default_local" in data:
        city.default_local = str(data.get("default_local") or "Microsoft Teams")[:180]
    if "default_footer" in data:
        city.default_footer = str(data.get("default_footer") or "DIE – Departamento de Inteligência Estratégica")[:220]
    if "display_order" in data:
        try:
            city.display_order = max(1, int(data.get("display_order") or city.display_order))
        except (TypeError, ValueError):
            pass
    if "is_active" in data:
        city.is_active = bool(data.get("is_active"))
    if "default_primary_color" in data:
        city.default_primary_color = _normalize_hex_color(data.get("default_primary_color"), "#0a7e3a")
    if "default_secondary_color" in data:
        city.default_secondary_color = _normalize_hex_color(data.get("default_secondary_color"), "#b4c85a")

    if data.get("remove_logo") is True:
        city.logo_data_url = None
        city.logo_mime_type = None
    elif "logo_data_url" in data and data.get("logo_data_url") is not None:
        raw_logo = str(data.get("logo_data_url") or "").strip()
        if raw_logo == "":
            city.logo_data_url = None
            city.logo_mime_type = None
        else:
            try:
                logo_url, logo_mime = validate_logo_data_url(raw_logo)
                city.logo_data_url = logo_url
                city.logo_mime_type = logo_mime
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400

    if data.get("remove_report_logo") is True:
        city.report_logo_data_url = None
    elif "report_logo_data_url" in data and data.get("report_logo_data_url") is not None:
        raw_rlogo = str(data.get("report_logo_data_url") or "").strip()
        if raw_rlogo == "":
            city.report_logo_data_url = None
        else:
            try:
                rlogo_url, _ = validate_logo_data_url(raw_rlogo)
                city.report_logo_data_url = rlogo_url
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400

    log_audit(
        g.db,
        event_type="city_updated",
        actor_type="admin",
        actor_identifier=g.admin_user.email,
        city_id=city.id,
        details={"name": city.name, "project_name": city.project_name, "has_logo": bool(city.logo_data_url)},
        ip_address=get_client_ip(request),
        user_agent=request.headers.get("User-Agent", ""),
    )
    g.db.commit()
    return jsonify({"city": city.to_dict(include_logo=True)}), 200


@admin_bp.route("/cities/<city_id>/timeline", methods=["GET"])
@require_admin
def get_city_timeline(city_id: str):
    city = g.db.query(City).filter(City.id == city_id).first()
    if not city:
        return jsonify({"error": "Cidade/projeto não encontrado."}), 404

    meetings = list(city.meetings)
    timeline_meetings = [_serialize_meeting_summary(g.db, m) for m in meetings]

    # Matriz comparativa de indicadores entre reuniões mensais (mais antiga -> mais recente)
    chrono_meetings = list(reversed(meetings))
    indicator_labels: list[str] = []
    seen_labels: set[str] = set()
    for mt in chrono_meetings:
        for ind in mt.indicators:
            key = ind.label.strip().lower()
            if key and key not in seen_labels:
                seen_labels.add(key)
                indicator_labels.append(ind.label.strip())

    indicator_matrix = []
    for label in indicator_labels:
        row_values = []
        for mt in chrono_meetings:
            match = next((i for i in mt.indicators if i.label.strip().lower() == label.lower()), None)
            row_values.append(
                {
                    "meeting_id": mt.id,
                    "reference_label": mt.reference_label or mt.title,
                    "value": match.value if match else "—",
                    "status": match.status if match else "none",
                }
            )
        indicator_matrix.append({"label": label, "series": row_values})

    action_history = []
    for mt, act in _iter_consolidated_city_actions(meetings):
        d = act.to_dict()
        d["meeting_title"] = mt.title
        d["reference_label"] = mt.reference_label
        d["meeting_date"] = mt.meeting_date
        d["date_text"] = mt.date_text
        d["meeting_workflow_status"] = mt.workflow_status
        action_history.append(d)

    return (
        jsonify(
            {
                "city": city.to_dict(include_logo=True),
                "meetings": timeline_meetings,
                "indicator_columns": [
                    {
                        "meeting_id": mt.id,
                        "reference_label": mt.reference_label or mt.title,
                        "date_text": mt.date_text,
                    }
                    for mt in chrono_meetings
                ],
                "indicator_matrix": indicator_matrix,
                "action_history": action_history,
            }
        ),
        200,
    )


# -------------------- Reuniões, Acompanhamento e Importação de Pendências --------------------


@admin_bp.route("/cities/<city_id>/meetings", methods=["GET"])
@require_admin
def list_city_meetings(city_id: str):
    city = g.db.query(City).filter(City.id == city_id).first()
    if not city:
        return jsonify({"error": "Cidade/projeto não encontrado."}), 404
    return (
        jsonify(
            {
                "city": city.to_dict(include_logo=True),
                "meetings": [_serialize_meeting_summary(g.db, m) for m in city.meetings],
            }
        ),
        200,
    )


@admin_bp.route("/cities/<city_id>/meetings", methods=["POST"])
@require_admin
def create_city_meeting(city_id: str):
    city = g.db.query(City).filter(City.id == city_id).first()
    if not city:
        return jsonify({"error": "Cidade/projeto não encontrado."}), 404

    data = request.get_json(silent=True) or {}
    ref_label = str(data.get("reference_label") or data.get("referenceLabel") or "").strip()
    title = str(data.get("title") or "").strip() or (
        f"Ata de Reunião de Indicadores {ref_label}" if ref_label else "Ata de Reunião de Indicadores"
    )
    meeting_date = str(data.get("meeting_date") or data.get("meetingDate") or "").strip()
    ref_month = str(data.get("reference_month") or data.get("referenceMonth") or "").strip()

    report_logo_url = city.report_logo_data_url
    if "reportLogoDataUrl" in data:
        raw_rl = str(data.get("reportLogoDataUrl") or "").strip()
        if raw_rl == "":
            report_logo_url = None
        else:
            try:
                report_logo_url, _ = validate_logo_data_url(raw_rl)
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400

    meeting = Meeting(
        city_id=city.id,
        reference_month=ref_month[:20],
        reference_label=ref_label[:80],
        meeting_date=meeting_date[:20],
        unit_name_display=str(data.get("unitName") or city.name)[:200],
        local=str(data.get("local") or city.default_local or "Microsoft Teams")[:180],
        date_text=str(data.get("dateText") or "")[:120],
        time_text=str(data.get("timeText") or "")[:40],
        participants=str(data.get("participants") or ""),
        title=title[:255],
        summary=str(data.get("summary") or ""),
        show_topics=bool(data.get("showTopics", True)),
        show_kpis_on_sheet=bool(data.get("showKpisOnSheet", False)),
        header_theme=str(data.get("headerTheme") or "die")[:20],
        primary_color=_normalize_hex_color(data.get("primaryColor"), city.default_primary_color or "#0a7e3a"),
        secondary_color=_normalize_hex_color(data.get("secondaryColor"), city.default_secondary_color or "#b4c85a"),
        report_logo_data_url=report_logo_url,
        density_mode=str(data.get("densityMode") or "auto")[:20],
        extra_blank_rows=max(0, min(6, int(data.get("extraBlankRows", 1) or 1))),
        footer_text=str(data.get("footerText") or city.default_footer or "DIE – Departamento de Inteligência Estratégica")[:220],
        workflow_status="rascunho",
        current_version_number=0,
        is_locked=False,
        created_by=g.admin_user.id,
    )
    meeting.set_topics(data.get("topics") or [])
    g.db.add(meeting)
    g.db.flush()

    if isinstance(data.get("indicators"), list):
        for idx, ind in enumerate(data["indicators"]):
            if isinstance(ind, dict):
                g.db.add(
                    MeetingIndicator(
                        meeting_id=meeting.id,
                        city_id=city.id,
                        label=str(ind.get("label") or "")[:160],
                        value=str(ind.get("value") or "")[:200],
                        status=str(ind.get("status") or "ok")[:20],
                        sort_order=idx,
                    )
                )

    if isinstance(data.get("actions"), list):
        for idx, act in enumerate(data["actions"]):
            if isinstance(act, dict):
                g.db.add(
                    ActionItem(
                        meeting_id=meeting.id,
                        city_id=city.id,
                        origin_action_id=act.get("origin_action_id"),
                        action_text=str(act.get("action") or ""),
                        owner=str(act.get("owner") or "")[:255],
                        deadline=str(act.get("deadline") or "")[:160],
                        status_text=str(act.get("status") or "")[:160],
                        tracking_status="pendente",
                        checked_completed=False,
                        sort_order=idx,
                    )
                )

    g.db.flush()

    # Por padrão, puxar automaticamente as ações pendentes da reunião anterior na criação
    if data.get("auto_import_pending", True):
        prev = _find_previous_meeting(g.db, meeting)
        if prev:
            sort_idx = len(meeting.actions)
            for src in prev.actions:
                if not src.checked_completed and src.tracking_status != "concluida":
                    g.db.add(
                        ActionItem(
                            meeting_id=meeting.id,
                            city_id=city.id,
                            origin_action_id=src.id,
                            action_text=src.action_text,
                            owner=src.owner,
                            deadline=src.deadline,
                            status_text="",
                            tracking_status=src.tracking_status or "pendente",
                            checked_completed=False,
                            sort_order=sort_idx,
                        )
                    )
                    sort_idx += 1

    log_audit(
        g.db,
        event_type="meeting_created",
        actor_type="admin",
        actor_identifier=g.admin_user.email,
        city_id=city.id,
        meeting_id=meeting.id,
        details={"title": meeting.title, "reference_label": meeting.reference_label},
        ip_address=get_client_ip(request),
        user_agent=request.headers.get("User-Agent", ""),
    )
    g.db.commit()
    g.db.refresh(meeting)
    return jsonify(_serialize_meeting_full(g.db, meeting)), 201


@admin_bp.route("/meetings/<meeting_id>", methods=["GET"])
@require_admin
def get_meeting(meeting_id: str):
    meeting = g.db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting:
        return jsonify({"error": "Reunião não encontrada."}), 404
    return jsonify(_serialize_meeting_full(g.db, meeting)), 200


@admin_bp.route("/meetings/<meeting_id>", methods=["PUT"])
@require_admin
def update_meeting(meeting_id: str):
    meeting = g.db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting:
        return jsonify({"error": "Reunião não encontrada."}), 404

    if meeting.is_locked:
        return (
            jsonify(
                {
                    "error": (
                        "Este relatório já teve o link enviado e está bloqueado para edição. "
                        "Apenas o status do plano de ação pode ser alterado."
                    ),
                    "code": "MEETING_LOCKED",
                }
            ),
            409,
        )

    data = request.get_json(silent=True) or {}
    try:
        _apply_meeting_payload(g.db, meeting, data)
    except ValueError as exc:
        g.db.rollback()
        return jsonify({"error": str(exc)}), 400
    log_audit(
        g.db,
        event_type="meeting_updated",
        actor_type="admin",
        actor_identifier=g.admin_user.email,
        city_id=meeting.city_id,
        meeting_id=meeting.id,
        details={"title": meeting.title},
        ip_address=get_client_ip(request),
        user_agent=request.headers.get("User-Agent", ""),
    )
    g.db.commit()
    g.db.refresh(meeting)
    return jsonify(_serialize_meeting_full(g.db, meeting)), 200


@admin_bp.route("/meetings/<meeting_id>", methods=["DELETE"])
@require_admin
def delete_meeting(meeting_id: str):
    meeting = g.db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting:
        return jsonify({"error": "Reunião não encontrada."}), 404
    if meeting.is_locked or meeting.current_version_number > 0 or len(meeting.versions) > 0:
        return (
            jsonify(
                {
                    "error": "Reuniões com versão definitiva gerada ou confirmada não podem ser excluídas."
                }
            ),
            409,
        )
    city_id = meeting.city_id
    title = meeting.title
    g.db.delete(meeting)
    log_audit(
        g.db,
        event_type="meeting_draft_deleted",
        actor_type="admin",
        actor_identifier=g.admin_user.email,
        city_id=city_id,
        details={"deleted_meeting_id": meeting_id, "title": title},
        ip_address=get_client_ip(request),
        user_agent=request.headers.get("User-Agent", ""),
    )
    g.db.commit()
    return jsonify({"ok": True}), 200


@admin_bp.route("/actions/<action_id>/tracking", methods=["PATCH"])
@require_admin
def update_action_tracking(action_id: str):
    """Atualiza o check de realização/acompanhamento da ação sem alterar o PDF congelado."""
    item = g.db.query(ActionItem).filter(ActionItem.id == action_id).first()
    if not item:
        return jsonify({"error": "Item de ação não encontrado."}), 404

    data = request.get_json(silent=True) or {}
    if "checked_completed" in data:
        checked = bool(data.get("checked_completed"))
        item.checked_completed = checked
        if "tracking_status" not in data:
            item.tracking_status = "concluida" if checked else "pendente"
        item.checked_at = utcnow_naive() if checked else None
        item.checked_by = g.admin_user.name if checked else None

    if "tracking_status" in data:
        ts = str(data.get("tracking_status") or "pendente")
        if ts not in ALLOWED_TRACKING_STATUSES:
            return jsonify({"error": "Status de acompanhamento inválido."}), 400
        item.tracking_status = ts
        if "checked_completed" not in data:
            item.checked_completed = ts == "concluida"
            item.checked_at = utcnow_naive() if item.checked_completed else None
            item.checked_by = g.admin_user.name if item.checked_completed else None

    if "follow_up_notes" in data:
        item.follow_up_notes = str(data.get("follow_up_notes") or "")

    log_audit(
        g.db,
        event_type="action_tracking_updated",
        actor_type="admin",
        actor_identifier=g.admin_user.email,
        city_id=item.city_id,
        meeting_id=item.meeting_id,
        details={
            "action_id": item.id,
            "checked_completed": item.checked_completed,
            "tracking_status": item.tracking_status,
        },
        ip_address=get_client_ip(request),
        user_agent=request.headers.get("User-Agent", ""),
    )
    g.db.commit()
    g.db.refresh(item)
    return jsonify({"action": item.to_dict()}), 200


@admin_bp.route("/meetings/<meeting_id>/import-pending-actions", methods=["POST"])
@require_admin
def import_pending_actions(meeting_id: str):
    """Importa ações pendentes da reunião anterior para a ata atual mantendo Status vazio para papel."""
    meeting = g.db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting:
        return jsonify({"error": "Reunião não encontrada."}), 404
    if meeting.is_locked:
        return jsonify({"error": "Ata confirmada está travada. Crie uma nova versão antes de importar ações."}), 409

    data = request.get_json(silent=True) or {}
    source_id = str(data.get("source_meeting_id") or "").strip()
    if source_id:
        source = (
            g.db.query(Meeting)
            .filter(Meeting.id == source_id, Meeting.city_id == meeting.city_id)
            .first()
        )
    else:
        source = _find_previous_meeting(g.db, meeting)

    if not source:
        return jsonify({"error": "Nenhuma reunião anterior encontrada para esta cidade."}), 404

    existing_origins = {a.origin_action_id for a in meeting.actions if a.origin_action_id}
    existing_texts = {_normalize_action_text(a.action_text) for a in meeting.actions if _normalize_action_text(a.action_text)}
    sort_idx = len(meeting.actions)
    imported_count = 0

    for src in source.actions:
        if src.checked_completed or src.tracking_status == "concluida":
            continue
        norm_src = _normalize_action_text(src.action_text)
        if src.id in existing_origins or (norm_src and norm_src in existing_texts):
            continue
        if norm_src:
            existing_texts.add(norm_src)
        g.db.add(
            ActionItem(
                meeting_id=meeting.id,
                city_id=meeting.city_id,
                origin_action_id=src.id,
                action_text=src.action_text,
                owner=src.owner,
                deadline=src.deadline,
                status_text="",
                tracking_status="pendente",
                checked_completed=False,
                sort_order=sort_idx,
            )
        )
        sort_idx += 1
        imported_count += 1

    log_audit(
        g.db,
        event_type="pending_actions_imported",
        actor_type="admin",
        actor_identifier=g.admin_user.email,
        city_id=meeting.city_id,
        meeting_id=meeting.id,
        details={"source_meeting_id": source.id, "imported_count": imported_count},
        ip_address=get_client_ip(request),
        user_agent=request.headers.get("User-Agent", ""),
    )
    g.db.commit()
    g.db.refresh(meeting)
    payload = _serialize_meeting_full(g.db, meeting)
    payload["imported_count"] = imported_count
    return jsonify(payload), 200


# -------------------- Finalização de PDF, Versões e Link Público --------------------


def _freeze_meeting_pdf_version(
    db: Session, meeting: Meeting, admin_user: AdminUser, change_reason: str = ""
) -> MeetingVersion:
    """Gera o PDF definitivo da ata e registra uma nova MeetingVersion imutável."""
    db.refresh(meeting)
    city = meeting.city
    snapshot = meeting.to_editor_snapshot()
    city_snapshot = city.to_dict(include_logo=True) if city else {}

    pdf_bytes, pdf_sha256, pdf_engine = render_meeting_pdf(snapshot, city_snapshot)

    next_version_num = max([v.version_number for v in meeting.versions], default=0) + 1
    for prev_ver in meeting.versions:
        if prev_ver.is_current:
            prev_ver.is_current = False

    now = utcnow_naive()
    for old_link in meeting.public_links:
        if old_link.status == "active":
            old_link.status = "revoked"
            old_link.revoked_at = now
            old_link.revoked_by_name = admin_user.name
            old_link.revoke_reason = f"Substituído pela versão v{next_version_num}"

    city_slug = city.slug if city else "unidade"
    ref_slug = _slugify(meeting.reference_label or meeting.reference_month or "ata")
    pdf_filename = sanitize_filename(f"ata_{city_slug}_{ref_slug}_v{next_version_num}.pdf")
    reason_text = str(change_reason or "").strip() or (
        "Versão inicial definitiva" if next_version_num == 1 else f"Revisão v{next_version_num}"
    )

    version = MeetingVersion(
        meeting_id=meeting.id,
        city_id=meeting.city_id,
        version_number=next_version_num,
        is_current=True,
        change_reason=reason_text[:300],
        snapshot_json=json.dumps(snapshot, ensure_ascii=False),
        pdf_filename=pdf_filename,
        pdf_content=pdf_bytes,
        pdf_size_bytes=len(pdf_bytes),
        pdf_sha256=pdf_sha256,
        generated_by=admin_user.id,
        generated_by_name=admin_user.name,
        generated_at=now,
    )
    db.add(version)
    db.flush()

    meeting.current_version_number = next_version_num
    log_audit(
        db,
        event_type="meeting_pdf_finalized",
        actor_type="admin",
        actor_identifier=admin_user.email,
        city_id=meeting.city_id,
        meeting_id=meeting.id,
        meeting_version_id=version.id,
        details={
            "version_number": next_version_num,
            "pdf_sha256": pdf_sha256,
            "pdf_size_bytes": len(pdf_bytes),
            "pdf_engine": pdf_engine,
            "change_reason": reason_text,
        },
        ip_address=get_client_ip(request),
        user_agent=request.headers.get("User-Agent", ""),
    )
    return version


@admin_bp.route("/meetings/<meeting_id>/finalize", methods=["POST"])
@require_admin
def finalize_meeting_pdf(meeting_id: str):
    meeting = g.db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting:
        return jsonify({"error": "Reunião não encontrada."}), 404
    if meeting.is_locked:
        return (
            jsonify(
                {
                    "error": "Este relatório já teve o link enviado ou confirmado e está bloqueado para edição.",
                    "code": "MEETING_LOCKED",
                }
            ),
            409,
        )

    data = request.get_json(silent=True) or {}
    try:
        if isinstance(data.get("snapshot"), dict):
            _apply_meeting_payload(g.db, meeting, data["snapshot"])
            g.db.flush()
        elif any(k in data for k in ("title", "summary", "actions", "unitName", "participants")):
            _apply_meeting_payload(g.db, meeting, data)
            g.db.flush()
    except ValueError as exc:
        g.db.rollback()
        return jsonify({"error": str(exc)}), 400

    try:
        version = _freeze_meeting_pdf_version(
            g.db, meeting, g.admin_user, change_reason=str(data.get("change_reason") or "")
        )
    except Exception as exc:
        g.db.rollback()
        return jsonify({"error": f"Erro ao gerar PDF definitivo da ata: {exc}"}), 500

    meeting.workflow_status = "aguardando_envio"
    meeting.is_locked = False

    g.db.commit()
    g.db.refresh(meeting)
    res = _serialize_meeting_full(g.db, meeting)
    res["generated_version"] = version.to_metadata_dict()
    return jsonify(res), 201


@admin_bp.route("/meetings/<meeting_id>/unlock-new-version", methods=["POST"])
@require_admin
def unlock_new_version(meeting_id: str):
    """Habilita criação de nova versão sem alterar PDF ou consentimento de versões anteriores."""
    meeting = g.db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting:
        return jsonify({"error": "Reunião não encontrada."}), 404

    data = request.get_json(silent=True) or {}
    reason = str(data.get("change_reason") or "").strip() or "Nova versão aberta para correção/atualização"

    now = utcnow_naive()
    for link in meeting.public_links:
        if link.status == "active":
            link.status = "revoked"
            link.revoked_at = now
            link.revoked_by_name = g.admin_user.name
            link.revoke_reason = "Nova revisão da ata iniciada pela administração"

    meeting.is_locked = False
    meeting.workflow_status = "aguardando_envio"

    log_audit(
        g.db,
        event_type="new_version_unlocked",
        actor_type="admin",
        actor_identifier=g.admin_user.email,
        city_id=meeting.city_id,
        meeting_id=meeting.id,
        details={"reason": reason, "previous_version_number": meeting.current_version_number},
        ip_address=get_client_ip(request),
        user_agent=request.headers.get("User-Agent", ""),
    )
    g.db.commit()
    g.db.refresh(meeting)
    return jsonify(_serialize_meeting_full(g.db, meeting)), 200


@admin_bp.route("/meetings/<meeting_id>/versions", methods=["GET"])
@require_admin
def get_meeting_versions(meeting_id: str):
    meeting = g.db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting:
        return jsonify({"error": "Reunião não encontrada."}), 404
    sync_expired_links_for_meeting(g.db, meeting)
    audit_rows = (
        g.db.query(AuditLog)
        .filter(AuditLog.meeting_id == meeting.id)
        .order_by(desc(AuditLog.created_at))
        .limit(100)
        .all()
    )
    return (
        jsonify(
            {
                "versions": [v.to_metadata_dict() for v in meeting.versions],
                "links": [_serialize_link_admin(l) for l in meeting.public_links],
                "consents": [c.to_dict() for c in meeting.consents],
                "audit_logs": [a.to_dict() for a in audit_rows],
            }
        ),
        200,
    )


@admin_bp.route("/meetings/<meeting_id>/versions/<version_id>/pdf", methods=["GET"])
@require_admin
def download_version_pdf(meeting_id: str, version_id: str):
    version = (
        g.db.query(MeetingVersion)
        .filter(MeetingVersion.id == version_id, MeetingVersion.meeting_id == meeting_id)
        .first()
    )
    if not version:
        return jsonify({"error": "Versão em PDF não encontrada."}), 404

    as_download = request.args.get("download") == "1"
    disposition = "attachment" if as_download else "inline"
    filename = sanitize_filename(version.pdf_filename)
    return Response(
        version.pdf_content,
        status=200,
        headers={
            "Content-Type": "application/pdf",
            "Content-Disposition": f'{disposition}; filename="{filename}"',
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        },
    )


@admin_bp.route("/meetings/<meeting_id>/public-link", methods=["POST"])
@require_admin
def create_public_link(meeting_id: str):
    meeting = g.db.query(Meeting).filter(Meeting.id == meeting_id).first()
    if not meeting:
        return jsonify({"error": "Reunião não encontrada."}), 404

    if meeting.workflow_status == "confirmada":
        return (
            jsonify({"error": "Esta ata já possui consentimento confirmado."}),
            409,
        )

    data = request.get_json(silent=True) or {}
    if not meeting.is_locked:
        try:
            if isinstance(data.get("snapshot"), dict):
                _apply_meeting_payload(g.db, meeting, data["snapshot"])
                g.db.flush()
            elif any(k in data for k in ("title", "summary", "actions", "unitName", "participants", "primaryColor", "secondaryColor", "reportLogoDataUrl")):
                _apply_meeting_payload(g.db, meeting, data)
                g.db.flush()
        except ValueError as exc:
            g.db.rollback()
            return jsonify({"error": str(exc)}), 400

    current_version = next((v for v in meeting.versions if v.is_current), None)
    if current_version:
        existing_consent = (
            g.db.query(ConsentRecord)
            .filter(ConsentRecord.meeting_version_id == current_version.id)
            .first()
        )
        if existing_consent:
            return (
                jsonify(
                    {
                        "error": f"A versão vigente (v{current_version.version_number}) já possui consentimento registrado."
                    }
                ),
                409,
            )

    if not current_version or (bool(data.get("auto_finalize")) and not meeting.is_locked):
        try:
            current_version = _freeze_meeting_pdf_version(
                g.db, meeting, g.admin_user, change_reason="Versão definitiva para envio do link"
            )
        except Exception as exc:
            g.db.rollback()
            return jsonify({"error": f"Erro ao gerar PDF definitivo da ata: {exc}"}), 500

    try:
        days = int(data.get("expires_in_days") or get_default_link_days())
    except (TypeError, ValueError):
        days = get_default_link_days()
    days = max(1, min(180, days))

    now = utcnow_naive()
    # Revoga links ativos anteriores da reunião
    for old_link in meeting.public_links:
        if old_link.status == "active":
            old_link.status = "revoked"
            old_link.revoked_at = now
            old_link.revoked_by_name = g.admin_user.name
            old_link.revoke_reason = "Substituído por novo link gerado pelo administrador"

    raw_token = generate_secure_token()
    link = PublicLink(
        city_id=meeting.city_id,
        meeting_id=meeting.id,
        meeting_version_id=current_version.id,
        token_hash=sha256_hex(raw_token),
        token_encrypted=encrypt_token(raw_token),
        status="active",
        expires_at=now + timedelta(days=days),
        created_by=g.admin_user.id,
        created_by_name=g.admin_user.name,
        created_at=now,
    )
    g.db.add(link)
    meeting.workflow_status = "link_enviado"
    meeting.is_locked = True
    g.db.flush()

    log_audit(
        g.db,
        event_type="public_link_created",
        actor_type="admin",
        actor_identifier=g.admin_user.email,
        city_id=meeting.city_id,
        meeting_id=meeting.id,
        meeting_version_id=current_version.id,
        details={"link_id": link.id, "version_number": current_version.version_number, "expires_in_days": days},
        ip_address=get_client_ip(request),
        user_agent=request.headers.get("User-Agent", ""),
    )
    g.db.commit()
    g.db.refresh(link)

    return (
        jsonify(
            {
                "link": _serialize_link_admin(link),
                "public_url": _build_public_url(raw_token),
                "version_number": current_version.version_number,
                "workflow_status": meeting.workflow_status,
                "workflow_label": _workflow_label(meeting.workflow_status),
                "is_locked": True,
                "current_version": current_version.to_metadata_dict(),
            }
        ),
        201,
    )


@admin_bp.route("/public-links/<link_id>/revoke", methods=["POST"])
@require_admin
def revoke_public_link(link_id: str):
    link = g.db.query(PublicLink).filter(PublicLink.id == link_id).first()
    if not link:
        return jsonify({"error": "Link público não encontrado."}), 404

    if link.status == "used":
        return jsonify({"error": "Este link já foi utilizado para confirmação e não pode ser invalidado."}), 409

    data = request.get_json(silent=True) or {}
    reason = str(data.get("reason") or "Invalidado manualmente pelo administrador LOCAR").strip()[:300]

    now = utcnow_naive()
    link.status = "revoked"
    link.revoked_at = now
    link.revoked_by_name = g.admin_user.name
    link.revoke_reason = reason

    meeting = link.meeting
    if meeting and meeting.workflow_status != "confirmada":
        has_other_active = (
            g.db.query(PublicLink)
            .filter(
                PublicLink.meeting_id == meeting.id,
                PublicLink.id != link.id,
                PublicLink.status == "active",
            )
            .first()
            is not None
        )
        if not has_other_active:
            meeting.workflow_status = "link_invalido"

    log_audit(
        g.db,
        event_type="public_link_revoked",
        actor_type="admin",
        actor_identifier=g.admin_user.email,
        city_id=link.city_id,
        meeting_id=link.meeting_id,
        meeting_version_id=link.meeting_version_id,
        details={"link_id": link.id, "reason": reason},
        ip_address=get_client_ip(request),
        user_agent=request.headers.get("User-Agent", ""),
    )
    g.db.commit()
    return (
        jsonify(
            {
                "ok": True,
                "link": _serialize_link_admin(link),
                "workflow_status": meeting.workflow_status if meeting else None,
                "workflow_label": _workflow_label(meeting.workflow_status) if meeting else None,
            }
        ),
        200,
    )
