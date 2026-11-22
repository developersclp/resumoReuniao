"""Modelos ORM do sistema Grupo LOCAR (12 cidades/projetos, atas, PDFs congelados e consentimentos)."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.database import Base


def utcnow_naive() -> datetime:
    """Retorna datetime UTC naive para compatibilidade idêntica entre SQLite e PostgreSQL."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso_utc(dt: datetime | None) -> str | None:
    """Formata datetime UTC naive como ISO-8601 com sufixo Z."""
    if dt is None:
        return None
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def new_uuid() -> str:
    return str(uuid.uuid4())


WORKFLOW_LABELS = {
    "rascunho": "Aguardando envio",
    "aguardando_envio": "Aguardando envio",
    "link_enviado": "Link enviado",
    "aguardando_confirmacao": "Aguardando confirmação",
    "confirmada": "Confirmada",
    "link_invalido": "Link expirado ou invalidado",
}


class AdminUser(Base):
    __tablename__ = "admin_users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    email: Mapped[str] = mapped_column(String(200), nullable=False, unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(40), nullable=False, default="admin")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow_naive)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow_naive, onupdate=utcnow_naive)

    sessions: Mapped[list["AdminSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "role": self.role,
            "is_active": self.is_active,
            "created_at": iso_utc(self.created_at),
            "updated_at": iso_utc(self.updated_at),
        }


class AdminSession(Base):
    __tablename__ = "admin_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("admin_users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    ip_address: Mapped[str | None] = mapped_column(String(80), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow_naive)

    user: Mapped["AdminUser"] = relationship(back_populates="sessions")


class City(Base):
    """Cidade ou projeto de limpeza gerenciado pelo Grupo LOCAR."""

    __tablename__ = "cities"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    slug: Mapped[str] = mapped_column(String(120), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(180), nullable=False)
    project_name: Mapped[str] = mapped_column(String(220), nullable=False)
    project_code: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    state_uf: Mapped[str] = mapped_column(String(10), nullable=False, default="")
    logo_data_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    logo_mime_type: Mapped[str | None] = mapped_column(String(60), nullable=True)
    institutional_info: Mapped[str] = mapped_column(Text, nullable=False, default="")
    default_local: Mapped[str] = mapped_column(String(180), nullable=False, default="Microsoft Teams")
    default_footer: Mapped[str] = mapped_column(
        String(220), nullable=False, default="DIE – Departamento de Inteligência Estratégica"
    )
    display_order: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow_naive)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow_naive, onupdate=utcnow_naive)

    meetings: Mapped[list["Meeting"]] = relationship(
        back_populates="city", cascade="all, delete-orphan", order_by="desc(Meeting.meeting_date), desc(Meeting.created_at)"
    )

    def to_dict(self, include_logo: bool = True) -> dict:
        data = {
            "id": self.id,
            "slug": self.slug,
            "name": self.name,
            "project_name": self.project_name,
            "project_code": self.project_code,
            "state_uf": self.state_uf,
            "has_logo": bool(self.logo_data_url),
            "logo_mime_type": self.logo_mime_type,
            "institutional_info": self.institutional_info,
            "default_local": self.default_local,
            "default_footer": self.default_footer,
            "display_order": self.display_order,
            "is_active": self.is_active,
            "created_at": iso_utc(self.created_at),
            "updated_at": iso_utc(self.updated_at),
        }
        if include_logo:
            data["logo_data_url"] = self.logo_data_url or ""
        return data


class Meeting(Base):
    """Reunião mensal de indicadores vinculada a uma cidade/projeto."""

    __tablename__ = "meetings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    city_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("cities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    reference_month: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    reference_label: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    meeting_date: Mapped[str] = mapped_column(String(20), nullable=False, default="")
    unit_name_display: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    local: Mapped[str] = mapped_column(String(180), nullable=False, default="Microsoft Teams")
    date_text: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    time_text: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    participants: Mapped[str] = mapped_column(Text, nullable=False, default="")
    title: Mapped[str] = mapped_column(String(255), nullable=False, default="Ata de Reunião de Indicadores")
    summary: Mapped[str] = mapped_column(Text, nullable=False, default="")
    show_topics: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    topics_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    show_kpis_on_sheet: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    header_theme: Mapped[str] = mapped_column(String(20), nullable=False, default="die")
    density_mode: Mapped[str] = mapped_column(String(20), nullable=False, default="auto")
    extra_blank_rows: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    footer_text: Mapped[str] = mapped_column(
        String(220), nullable=False, default="DIE – Departamento de Inteligência Estratégica"
    )
    workflow_status: Mapped[str] = mapped_column(String(40), nullable=False, default="rascunho", index=True)
    current_version_number: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_locked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("admin_users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow_naive)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow_naive, onupdate=utcnow_naive)

    city: Mapped["City"] = relationship(back_populates="meetings")
    indicators: Mapped[list["MeetingIndicator"]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan", order_by="MeetingIndicator.sort_order"
    )
    actions: Mapped[list["ActionItem"]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan", order_by="ActionItem.sort_order"
    )
    versions: Mapped[list["MeetingVersion"]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan", order_by="desc(MeetingVersion.version_number)"
    )
    public_links: Mapped[list["PublicLink"]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan", order_by="desc(PublicLink.created_at)"
    )
    consents: Mapped[list["ConsentRecord"]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan", order_by="desc(ConsentRecord.accepted_at)"
    )

    def get_topics(self) -> list[dict]:
        try:
            parsed = json.loads(self.topics_json or "[]")
            return parsed if isinstance(parsed, list) else []
        except Exception:
            return []

    def set_topics(self, topics: list[dict] | None) -> None:
        cleaned = []
        for item in topics or []:
            if isinstance(item, dict):
                cleaned.append({"area": str(item.get("area", "")), "text": str(item.get("text", ""))})
        self.topics_json = json.dumps(cleaned, ensure_ascii=False)

    def to_editor_snapshot(self) -> dict:
        """Retorna snapshot compatível com o editor A4 original e com o gerador de PDF."""
        return {
            "id": self.id,
            "cityId": self.city_id,
            "referenceMonth": self.reference_month,
            "referenceLabel": self.reference_label,
            "meetingDate": self.meeting_date,
            "unitName": self.unit_name_display or (self.city.name if self.city else ""),
            "local": self.local,
            "dateText": self.date_text,
            "timeText": self.time_text,
            "participants": self.participants,
            "title": self.title,
            "summary": self.summary,
            "showTopics": bool(self.show_topics),
            "topics": self.get_topics(),
            "showKpisOnSheet": bool(self.show_kpis_on_sheet),
            "headerTheme": self.header_theme or "die",
            "densityMode": self.density_mode or "auto",
            "extraBlankRows": int(self.extra_blank_rows if self.extra_blank_rows is not None else 1),
            "footerText": self.footer_text or "DIE – Departamento de Inteligência Estratégica",
            "indicators": [ind.to_dict() for ind in self.indicators],
            "actions": [act.to_dict() for act in self.actions],
        }


class MeetingIndicator(Base):
    __tablename__ = "meeting_indicators"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    meeting_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    city_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("cities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    label: Mapped[str] = mapped_column(String(160), nullable=False)
    value: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="ok")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    meeting: Mapped["Meeting"] = relationship(back_populates="indicators")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "value": self.value,
            "status": self.status,
            "sort_order": self.sort_order,
        }


class ActionItem(Base):
    __tablename__ = "action_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    meeting_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    city_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("cities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    origin_action_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    action_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    owner: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    deadline: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    status_text: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    tracking_status: Mapped[str] = mapped_column(String(30), nullable=False, default="pendente")
    checked_completed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    checked_by: Mapped[str | None] = mapped_column(String(160), nullable=True)
    follow_up_notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow_naive, onupdate=utcnow_naive)

    meeting: Mapped["Meeting"] = relationship(back_populates="actions")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "meeting_id": self.meeting_id,
            "city_id": self.city_id,
            "origin_action_id": self.origin_action_id,
            "action": self.action_text,
            "owner": self.owner,
            "deadline": self.deadline,
            "status": self.status_text,
            "tracking_status": self.tracking_status,
            "checked_completed": bool(self.checked_completed),
            "checked_at": iso_utc(self.checked_at),
            "checked_by": self.checked_by,
            "follow_up_notes": self.follow_up_notes or "",
            "sort_order": self.sort_order,
            "updated_at": iso_utc(self.updated_at),
        }


class MeetingVersion(Base):
    """Versão definitiva congelada em PDF de uma reunião."""

    __tablename__ = "meeting_versions"
    __table_args__ = (UniqueConstraint("meeting_id", "version_number", name="uq_meeting_version_number"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    meeting_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    city_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("cities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    change_reason: Mapped[str] = mapped_column(String(300), nullable=False, default="Versão inicial")
    snapshot_json: Mapped[str] = mapped_column(Text, nullable=False)
    pdf_filename: Mapped[str] = mapped_column(String(220), nullable=False)
    pdf_content: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    pdf_size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    pdf_sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    generated_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("admin_users.id", ondelete="SET NULL"), nullable=True
    )
    generated_by_name: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    generated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow_naive)

    meeting: Mapped["Meeting"] = relationship(back_populates="versions")
    public_links: Mapped[list["PublicLink"]] = relationship(back_populates="version", cascade="all, delete-orphan")
    consent: Mapped["ConsentRecord | None"] = relationship(back_populates="version", uselist=False)

    def to_metadata_dict(self) -> dict:
        return {
            "id": self.id,
            "meeting_id": self.meeting_id,
            "city_id": self.city_id,
            "version_number": self.version_number,
            "is_current": bool(self.is_current),
            "change_reason": self.change_reason,
            "pdf_filename": self.pdf_filename,
            "pdf_size_bytes": self.pdf_size_bytes,
            "pdf_sha256": self.pdf_sha256,
            "generated_by_name": self.generated_by_name,
            "generated_at": iso_utc(self.generated_at),
            "has_consent": self.consent is not None,
        }


class PublicLink(Base):
    """Link público criptograficamente seguro vinculado a cidade, reunião e versão exata do PDF."""

    __tablename__ = "public_links"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    city_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("cities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    meeting_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    meeting_version_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meeting_versions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    token_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active", index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    view_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    first_viewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_viewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    pdf_viewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    pdf_downloaded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("admin_users.id", ondelete="SET NULL"), nullable=True
    )
    created_by_name: Mapped[str] = mapped_column(String(160), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow_naive)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_by_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    revoke_reason: Mapped[str | None] = mapped_column(String(300), nullable=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    meeting: Mapped["Meeting"] = relationship(back_populates="public_links")
    version: Mapped["MeetingVersion"] = relationship(back_populates="public_links")
    consent: Mapped["ConsentRecord | None"] = relationship(back_populates="public_link", uselist=False)


class ConsentRecord(Base):
    """Registro eletrônico auditável de consentimento vinculado à versão exata do PDF."""

    __tablename__ = "consent_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    protocol_code: Mapped[str] = mapped_column(String(40), nullable=False, unique=True, index=True)
    city_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("cities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    meeting_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    meeting_version_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meeting_versions.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    public_link_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("public_links.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    city_name_snapshot: Mapped[str] = mapped_column(String(180), nullable=False)
    project_name_snapshot: Mapped[str] = mapped_column(String(220), nullable=False)
    meeting_title_snapshot: Mapped[str] = mapped_column(String(255), nullable=False)
    meeting_date_snapshot: Mapped[str] = mapped_column(String(120), nullable=False)
    reference_label_snapshot: Mapped[str] = mapped_column(String(80), nullable=False)
    version_number_snapshot: Mapped[int] = mapped_column(Integer, nullable=False)
    pdf_filename_snapshot: Mapped[str] = mapped_column(String(220), nullable=False)
    pdf_sha256_snapshot: Mapped[str] = mapped_column(String(64), nullable=False)
    representative_name: Mapped[str] = mapped_column(String(200), nullable=False)
    representative_email: Mapped[str] = mapped_column(String(200), nullable=False)
    representative_role: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    consent_declaration: Mapped[str] = mapped_column(Text, nullable=False)
    accepted_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow_naive)
    client_ip: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    user_agent: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    accept_language: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    client_timezone: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    screen_resolution: Mapped[str] = mapped_column(String(40), nullable=False, default="")
    pdf_viewed_before_consent: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    pdf_downloaded_before_consent: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    integrity_hash: Mapped[str] = mapped_column(String(64), nullable=False)

    meeting: Mapped["Meeting"] = relationship(back_populates="consents")
    version: Mapped["MeetingVersion"] = relationship(back_populates="consent")
    public_link: Mapped["PublicLink"] = relationship(back_populates="consent")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "protocol_code": self.protocol_code,
            "city_id": self.city_id,
            "meeting_id": self.meeting_id,
            "meeting_version_id": self.meeting_version_id,
            "public_link_id": self.public_link_id,
            "city_name": self.city_name_snapshot,
            "project_name": self.project_name_snapshot,
            "meeting_title": self.meeting_title_snapshot,
            "meeting_date": self.meeting_date_snapshot,
            "reference_label": self.reference_label_snapshot,
            "version_number": self.version_number_snapshot,
            "pdf_filename": self.pdf_filename_snapshot,
            "pdf_sha256": self.pdf_sha256_snapshot,
            "representative_name": self.representative_name,
            "representative_email": self.representative_email,
            "representative_role": self.representative_role,
            "consent_declaration": self.consent_declaration,
            "accepted_at": iso_utc(self.accepted_at),
            "client_ip": self.client_ip,
            "user_agent": self.user_agent,
            "accept_language": self.accept_language,
            "client_timezone": self.client_timezone,
            "screen_resolution": self.screen_resolution,
            "pdf_viewed_before_consent": bool(self.pdf_viewed_before_consent),
            "pdf_downloaded_before_consent": bool(self.pdf_downloaded_before_consent),
            "integrity_hash": self.integrity_hash,
        }


class AuditLog(Base):
    """Registro cronológico de eventos administrativos e públicos para rastreabilidade."""

    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    event_type: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    actor_type: Mapped[str] = mapped_column(String(40), nullable=False)
    actor_identifier: Mapped[str] = mapped_column(String(200), nullable=False)
    city_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    meeting_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    meeting_version_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    details_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    ip_address: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    user_agent: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow_naive, index=True)

    def to_dict(self) -> dict:
        try:
            details = json.loads(self.details_json or "{}")
        except Exception:
            details = {}
        return {
            "id": self.id,
            "event_type": self.event_type,
            "actor_type": self.actor_type,
            "actor_identifier": self.actor_identifier,
            "city_id": self.city_id,
            "meeting_id": self.meeting_id,
            "meeting_version_id": self.meeting_version_id,
            "details": details,
            "ip_address": self.ip_address,
            "user_agent": self.user_agent,
            "created_at": iso_utc(self.created_at),
        }
