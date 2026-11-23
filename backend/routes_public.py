"""Rotas públicas sem autenticação para visualização do PDF congelado e consentimento auditável."""

from __future__ import annotations

from flask import Blueprint, Response, jsonify, request, send_from_directory
from sqlalchemy.exc import IntegrityError

from backend.config import BASE_DIR
from backend.database import SessionLocal
from backend.models import ActionItem, City, ConsentRecord, Meeting, MeetingVersion, PublicLink, iso_utc, utcnow_naive
from backend.security import (
    build_consent_integrity_hash,
    check_rate_limit,
    generate_protocol_code,
    get_client_ip,
    is_valid_email,
    log_audit,
    sanitize_filename,
    sha256_hex,
)

public_bp = Blueprint("public_consent", __name__)

ALLOWED_TRACKING_STATUSES = {"pendente", "em_andamento", "concluida", "nao_realizada"}

CONSENT_DECLARATION_TEXT = (
    "Declaro que li a ata da reunião e confirmo ciência do conteúdo e do plano de ação."
)

LEGAL_NOTICE_TEXT = ""


def _sync_if_expired(db, link: PublicLink) -> bool:
    if link.status == "active" and link.expires_at <= utcnow_naive():
        link.status = "expired"
        meeting = link.meeting
        if meeting and meeting.workflow_status in ("link_enviado", "aguardando_confirmacao"):
            meeting.workflow_status = "link_invalido"
        log_audit(
            db,
            event_type="public_link_expired",
            actor_type="system",
            actor_identifier="system",
            city_id=link.city_id,
            meeting_id=link.meeting_id,
            meeting_version_id=link.meeting_version_id,
            details={"link_id": link.id},
        )
        db.commit()
        return True
    return False


@public_bp.route("/ata/<token>", methods=["GET"])
def public_consent_page(token: str):
    """Serve a página simplificada e responsiva de visualização/consentimento sem acesso administrativo."""
    resp = send_from_directory(BASE_DIR / "public", "consent.html")
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    resp.headers["X-Robots-Tag"] = "noindex, nofollow"
    return resp


@public_bp.route("/api/public/atas/<token>", methods=["GET"])
def get_public_ata_details(token: str):
    db = SessionLocal()
    try:
        token_hash = sha256_hex(token)
        link = db.query(PublicLink).filter(PublicLink.token_hash == token_hash).first()
        if not link:
            return (
                jsonify(
                    {
                        "state": "not_found",
                        "message": "Link público não encontrado ou inválido.",
                    }
                ),
                404,
            )

        _sync_if_expired(db, link)
        meeting: Meeting = link.meeting
        version: MeetingVersion = link.version
        city: City | None = db.query(City).filter(City.id == link.city_id).first()

        if link.status in ("revoked", "expired"):
            msg = (
                "Este link foi invalidado pela administração da LOCAR."
                if link.status == "revoked"
                else "O prazo de validade deste link expirou."
            )
            return (
                jsonify(
                    {
                        "state": link.status,
                        "message": msg,
                        "city": {
                            "name": city.name if city else "",
                            "project_name": city.project_name if city else "",
                            "logo_data_url": city.logo_data_url if city else "",
                        },
                        "meeting": {
                            "title": meeting.title if meeting else "",
                            "reference_label": meeting.reference_label if meeting else "",
                            "date_text": meeting.date_text if meeting else "",
                        },
                    }
                ),
                410,
            )

        if link.status == "used":
            consent = link.consent or version.consent
            return (
                jsonify(
                    {
                        "state": "confirmed",
                        "message": "Consentimento já registrado para esta versão da ata.",
                        "city": {
                            "name": city.name if city else "",
                            "project_name": city.project_name if city else "",
                            "project_code": city.project_code if city else "",
                            "state_uf": city.state_uf if city else "",
                            "logo_data_url": (city.logo_data_url or "") if city else "",
                            "institutional_info": city.institutional_info if city else "",
                        },
                        "meeting": {
                            "title": meeting.title,
                            "date_text": meeting.date_text,
                            "time_text": meeting.time_text,
                            "local": meeting.local,
                            "reference_label": meeting.reference_label or meeting.title,
                        },
                        "version": {
                            "version_number": version.version_number,
                            "pdf_filename": version.pdf_filename,
                            "pdf_size_bytes": version.pdf_size_bytes,
                            "pdf_sha256": version.pdf_sha256,
                            "generated_at": iso_utc(version.generated_at),
                        },
                        "consent": consent.to_dict() if consent else None,
                        "actions": [act.to_dict() for act in meeting.actions],
                        "pdf_url": f"/api/public/atas/{token}/pdf",
                        "pdf_download_url": f"/api/public/atas/{token}/pdf?download=1",
                        "legal_notice": LEGAL_NOTICE_TEXT,
                    }
                ),
                200,
            )

        # Link ativo: registra abertura e avança situação para 'aguardando_confirmacao'
        now = utcnow_naive()
        link.view_count = (link.view_count or 0) + 1
        if link.first_viewed_at is None:
            link.first_viewed_at = now
        link.last_viewed_at = now
        if meeting.workflow_status == "link_enviado":
            meeting.workflow_status = "aguardando_confirmacao"

        log_audit(
            db,
            event_type="public_link_viewed",
            actor_type="representative",
            actor_identifier=get_client_ip(request) or "public",
            city_id=link.city_id,
            meeting_id=link.meeting_id,
            meeting_version_id=link.meeting_version_id,
            details={"link_id": link.id, "view_count": link.view_count},
            ip_address=get_client_ip(request),
            user_agent=request.headers.get("User-Agent", ""),
        )
        db.commit()

        return (
            jsonify(
                {
                    "state": "pending_consent",
                    "city": {
                        "name": city.name if city else "",
                        "project_name": city.project_name if city else "",
                        "project_code": city.project_code if city else "",
                        "state_uf": city.state_uf if city else "",
                        "logo_data_url": (city.logo_data_url or "") if city else "",
                        "institutional_info": city.institutional_info if city else "",
                    },
                    "meeting": {
                        "title": meeting.title,
                        "date_text": meeting.date_text,
                        "time_text": meeting.time_text,
                        "local": meeting.local,
                        "reference_label": meeting.reference_label or meeting.title,
                    },
                    "version": {
                        "version_number": version.version_number,
                        "is_current": bool(version.is_current),
                        "pdf_filename": version.pdf_filename,
                        "pdf_size_bytes": version.pdf_size_bytes,
                        "pdf_sha256": version.pdf_sha256,
                        "generated_at": iso_utc(version.generated_at),
                    },
                    "link": {
                        "expires_at": iso_utc(link.expires_at),
                        "view_count": link.view_count,
                    },
                    "actions": [act.to_dict() for act in meeting.actions],
                    "declaration_text": CONSENT_DECLARATION_TEXT,
                    "legal_notice": LEGAL_NOTICE_TEXT,
                    "pdf_url": f"/api/public/atas/{token}/pdf",
                    "pdf_download_url": f"/api/public/atas/{token}/pdf?download=1",
                }
            ),
            200,
        )
    finally:
        db.close()


@public_bp.route("/api/public/atas/<token>/pdf", methods=["GET"])
def get_public_ata_pdf(token: str):
    db = SessionLocal()
    try:
        token_hash = sha256_hex(token)
        link = db.query(PublicLink).filter(PublicLink.token_hash == token_hash).first()
        if not link:
            return jsonify({"error": "Link inválido ou não encontrado."}), 404

        _sync_if_expired(db, link)
        if link.status not in ("active", "used"):
            return jsonify({"error": "Documento indisponível: link expirado ou invalidado."}), 410

        version = link.version
        if not version:
            return jsonify({"error": "Documento PDF não localizado."}), 404

        is_download = request.args.get("download") == "1"
        now = utcnow_naive()
        if is_download:
            link.pdf_downloaded_at = link.pdf_downloaded_at or now
            event = "public_pdf_downloaded"
        else:
            link.pdf_viewed_at = link.pdf_viewed_at or now
            event = "public_pdf_viewed"

        log_audit(
            db,
            event_type=event,
            actor_type="representative",
            actor_identifier=get_client_ip(request) or "public",
            city_id=link.city_id,
            meeting_id=link.meeting_id,
            meeting_version_id=link.meeting_version_id,
            details={"link_id": link.id, "version_number": version.version_number},
            ip_address=get_client_ip(request),
            user_agent=request.headers.get("User-Agent", ""),
        )
        db.commit()

        disposition = "attachment" if is_download else "inline"
        filename = sanitize_filename(version.pdf_filename)
        return Response(
            version.pdf_content,
            status=200,
            headers={
                "Content-Type": "application/pdf",
                "Content-Disposition": f'{disposition}; filename="{filename}"',
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "frame-ancestors 'self'",
                "Cache-Control": "private, no-store",
            },
        )
    finally:
        db.close()


@public_bp.route("/api/public/atas/<token>/consent", methods=["POST"])
def submit_public_consent(token: str):
    ip = get_client_ip(request)
    if not check_rate_limit(f"public_consent:{ip}", max_hits=20, window_seconds=600):
        return jsonify({"error": "Limite de tentativas excedido. Aguarde alguns minutos."}), 429

    data = request.get_json(silent=True) or {}
    rep_name = str(data.get("representative_name") or data.get("full_name") or "").strip()
    rep_email = str(data.get("representative_email") or data.get("email") or "").strip().lower()
    rep_role = str(data.get("representative_role") or data.get("role") or "").strip()[:120]
    accepted_terms = data.get("accepted_terms") is True
    client_timezone = str(data.get("client_timezone") or "").strip()[:80]
    screen_resolution = str(data.get("screen_resolution") or "").strip()[:40]

    if len(rep_name) < 3:
        return jsonify({"error": "Informe o nome completo do representante (mínimo 3 caracteres)."}), 400
    if not is_valid_email(rep_email):
        return jsonify({"error": "Informe um endereço de e-mail válido."}), 400
    if not accepted_terms:
        return jsonify({"error": "Marque a caixa declarando que leu e concorda com o documento."}), 400

    db = SessionLocal()
    try:
        token_hash = sha256_hex(token)
        dialect_name = db.bind.dialect.name if db.bind else "sqlite"

        link_q = db.query(PublicLink).filter(PublicLink.token_hash == token_hash)
        if dialect_name == "postgresql":
            link_q = link_q.with_for_update()
        link = link_q.first()

        if not link:
            return jsonify({"error": "Link público não encontrado."}), 404

        _sync_if_expired(db, link)
        if link.status == "used":
            return jsonify({"error": "O consentimento desta ata já foi confirmado anteriormente."}), 409
        if link.status in ("revoked", "expired"):
            return jsonify({"error": "Este link foi invalidado ou expirou e não aceita mais confirmações."}), 410

        meeting_q = db.query(Meeting).filter(Meeting.id == link.meeting_id)
        if dialect_name == "postgresql":
            meeting_q = meeting_q.with_for_update()
        meeting = meeting_q.first()
        version = db.query(MeetingVersion).filter(MeetingVersion.id == link.meeting_version_id).first()
        city = db.query(City).filter(City.id == link.city_id).first()

        if not meeting or not version:
            return jsonify({"error": "Versão da ata não encontrada."}), 404
        if not version.is_current:
            return jsonify({"error": "Esta versão da ata foi substituída por uma revisão mais recente."}), 409

        existing = (
            db.query(ConsentRecord)
            .filter(ConsentRecord.meeting_version_id == version.id)
            .first()
        )
        if existing:
            return jsonify({"error": "Esta versão da ata já possui consentimento registrado."}), 409

        now = utcnow_naive()
        accepted_iso = iso_utc(now) or ""
        user_agent = request.headers.get("User-Agent", "")[:500]
        accept_language = request.headers.get("Accept-Language", "")[:120]
        protocol_code = generate_protocol_code(now)

        integrity_hash = build_consent_integrity_hash(
            protocol_code=protocol_code,
            city_id=link.city_id,
            meeting_id=meeting.id,
            meeting_version_id=version.id,
            pdf_sha256=version.pdf_sha256,
            representative_name=rep_name[:200],
            representative_email=rep_email[:200],
            accepted_at_iso=accepted_iso,
            client_ip=ip,
        )

        record = ConsentRecord(
            protocol_code=protocol_code,
            city_id=link.city_id,
            meeting_id=meeting.id,
            meeting_version_id=version.id,
            public_link_id=link.id,
            city_name_snapshot=(city.name if city else meeting.unit_name_display)[:180],
            project_name_snapshot=(city.project_name if city else meeting.unit_name_display)[:220],
            meeting_title_snapshot=meeting.title[:255],
            meeting_date_snapshot=meeting.date_text[:120],
            reference_label_snapshot=(meeting.reference_label or meeting.title)[:80],
            version_number_snapshot=version.version_number,
            pdf_filename_snapshot=version.pdf_filename[:220],
            pdf_sha256_snapshot=version.pdf_sha256,
            representative_name=rep_name[:200],
            representative_email=rep_email[:200],
            representative_role=rep_role,
            consent_declaration=CONSENT_DECLARATION_TEXT,
            accepted_at=now,
            client_ip=ip,
            user_agent=user_agent,
            accept_language=accept_language,
            client_timezone=client_timezone,
            screen_resolution=screen_resolution,
            pdf_viewed_before_consent=bool(link.pdf_viewed_at is not None),
            pdf_downloaded_before_consent=bool(link.pdf_downloaded_at is not None),
            integrity_hash=integrity_hash,
        )
        db.add(record)

        link.status = "used"
        link.used_at = now
        meeting.workflow_status = "confirmada"
        meeting.is_locked = True

        log_audit(
            db,
            event_type="consent_recorded",
            actor_type="representative",
            actor_identifier=f"{rep_name} <{rep_email}>",
            city_id=link.city_id,
            meeting_id=meeting.id,
            meeting_version_id=version.id,
            details={
                "protocol_code": protocol_code,
                "version_number": version.version_number,
                "pdf_sha256": version.pdf_sha256,
                "integrity_hash": integrity_hash,
            },
            ip_address=ip,
            user_agent=user_agent,
        )
        db.commit()
        db.refresh(record)

        return (
            jsonify(
                {
                    "ok": True,
                    "message": "Consentimento registrado com sucesso.",
                    "consent": record.to_dict(),
                    "legal_notice": LEGAL_NOTICE_TEXT,
                }
            ),
            201,
        )
    except IntegrityError:
        db.rollback()
        return jsonify({"error": "Esta ata já recebeu confirmação em uma requisição paralela."}), 409
    finally:
        db.close()


@public_bp.route("/api/public/atas/<token>/actions/<action_id>", methods=["PATCH"])
def update_public_action_status(token: str, action_id: str):
    """Permite ao representante da cidade atualizar status e observações do Plano de Ação pelo link público."""
    ip = get_client_ip(request)
    if not check_rate_limit(f"public_action:{ip}", max_hits=120, window_seconds=600):
        return jsonify({"error": "Limite de requisições excedido. Aguarde alguns minutos."}), 429

    db = SessionLocal()
    try:
        token_hash = sha256_hex(token)
        link = db.query(PublicLink).filter(PublicLink.token_hash == token_hash).first()
        if not link:
            return jsonify({"error": "Link público não encontrado."}), 404

        _sync_if_expired(db, link)
        if link.status not in ("active", "used"):
            return jsonify({"error": "Este link expirou ou foi invalidado."}), 410

        item = (
            db.query(ActionItem)
            .filter(ActionItem.id == action_id, ActionItem.meeting_id == link.meeting_id)
            .first()
        )
        if not item:
            return jsonify({"error": "Item do plano de ação não encontrado."}), 404

        data = request.get_json(silent=True) or {}
        if "tracking_status" in data:
            ts = str(data.get("tracking_status") or "pendente").strip()
            if ts not in ALLOWED_TRACKING_STATUSES:
                return jsonify({"error": "Status inválido."}), 400
            item.tracking_status = ts

        if "checked_completed" in data:
            checked = bool(data.get("checked_completed"))
            item.checked_completed = checked
            if "tracking_status" not in data:
                item.tracking_status = "concluida" if checked else "pendente"
        elif "tracking_status" in data:
            item.checked_completed = item.tracking_status == "concluida"

        if "follow_up_notes" in data:
            item.follow_up_notes = str(data.get("follow_up_notes") or "")[:500]

        updated_by = str(data.get("updated_by") or "").strip()[:120]
        consent_name = ""
        if link.consent:
            consent_name = link.consent.representative_name
        elif link.meeting and link.meeting.consents:
            consent_name = link.meeting.consents[0].representative_name
        actor_name = updated_by or consent_name or "Representante da Cidade"

        item.checked_at = utcnow_naive() if item.checked_completed else None
        item.checked_by = actor_name if item.checked_completed else None

        log_audit(
            db,
            event_type="public_action_status_updated",
            actor_type="representative",
            actor_identifier=actor_name,
            city_id=link.city_id,
            meeting_id=link.meeting_id,
            meeting_version_id=link.meeting_version_id,
            details={
                "action_id": item.id,
                "tracking_status": item.tracking_status,
                "checked_completed": item.checked_completed,
            },
            ip_address=ip,
            user_agent=request.headers.get("User-Agent", ""),
        )
        db.commit()
        db.refresh(item)
        return jsonify({"ok": True, "action": item.to_dict()}), 200
    finally:
        db.close()
