"""Gerador e limpador de dados de teste (4 meses de fluxo real nas 12 cidades LOCAR)."""

from __future__ import annotations

import argparse
import os
import sys
from datetime import timedelta
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR))

from backend.models import (
    ActionItem,
    AdminUser,
    AuditLog,
    City,
    ConsentRecord,
    Meeting,
    MeetingIndicator,
    MeetingVersion,
    PublicLink,
    utcnow_naive,
)
from backend.pdf_generator import render_meeting_pdf
from backend.security import (
    build_consent_integrity_hash,
    encrypt_token,
    generate_protocol_code,
    generate_secure_token,
    sha256_hex,
)

MONTHS_CONFIG = [
    {
        "ref_month": "2026-08",
        "ref_label": "Agosto/2026",
        "day": 14,
        "meet_month": 9,
        "date_suffix": "Segunda-Feira",
        "next_label": "Outubro/2026",
    },
    {
        "ref_month": "2026-09",
        "ref_label": "Setembro/2026",
        "day": 15,
        "meet_month": 10,
        "date_suffix": "Quinta-Feira",
        "next_label": "Novembro/2026",
    },
    {
        "ref_month": "2026-10",
        "ref_label": "Outubro/2026",
        "day": 16,
        "meet_month": 11,
        "date_suffix": "Segunda-Feira",
        "next_label": "Dezembro/2026",
    },
    {
        "ref_month": "2026-11",
        "ref_label": "Novembro/2026",
        "day": 23,
        "meet_month": 11,
        "date_suffix": "Segunda-Feira",
        "next_label": "Janeiro/2027",
    },
]

ACTION_TEMPLATES = [
    ("Auditoria e atualização do quadro de colaboradores afastados (INSS/auxílio-doença)", "Belisario e RH"),
    ("Implantar acompanhamento diário no Hub de Atestados e alinhar medidas disciplinares", "Vivian, Marcela e RH"),
    ("Reforçar recrutamento para recompor efetivo operacional da capina e coleta", "RH Local e Gestão"),
    ("Estudar redução de horas extras no abastecimento e turno noturno (escala 12x36)", "Vitor e Ezequias"),
    ("Verificar credenciamento de posto parceiro no sistema Shellbox para reduzir deslocamento", "Daniele Torres e Frota"),
    ("Priorizar pagamentos via planilha SharePoint para liberação de pneus e peças hidráulicas", "Carlos Filho e Compras"),
    ("Enviar protocolos das ouvidorias em aberto no BI para conferência e baixa pelo contrato", "Mônica Guerra e Laís"),
    ("Ampliar abertura de rotas no Inlog e revisar cadastro dos setores de feira", "Jessica e Tráfego"),
    ("Revisar treinamento de rotina do DTM e lançamentos preventivos no TOTVS", "Romário (DTM)"),
    ("Acompanhar encerramento e regularização de Banco de Horas junto ao DP", "Vitor e Alison"),
    ("Realizar inspeção de segurança do trabalho e reciclagem de EPIs nas frentes", "Segurança do Trabalho"),
    ("Elaborar prévia orçamentária do próximo trimestre (diesel, insumos e receita)", "Controladoria e Contrato"),
]

PARTICIPANTS_POOL = [
    "Jessica Gomes, Vivian Rodrigues, Belisario, Vitor Arruda, Daniele Torres, Romario de Moura, Mônica Guerra.",
    "Jessica Gomes, Vitor Arruda, Alison, Marcela Teixeira, Arthur Borella, Daniel Cabral, Romario Moura.",
    "Vivian Rodrigues, Belisario, Carlos Buarque Filho, Clécio Rodrigues, Guilherme Godoy, Carolina Buarque.",
]


def _make_sample_pdf(meeting: Meeting, city: City, cached_pdfs: dict[str, tuple[bytes, str]]) -> tuple[bytes, str]:
    """Gera PDF A4 real usando o motor do sistema (reaproveita cache por cidade para agilizar geração em lote)."""
    cache_key = f"{city.id}:{meeting.reference_month}"
    if cache_key not in cached_pdfs:
        pdf_bytes, pdf_sha, _ = render_meeting_pdf(meeting.to_editor_snapshot(), city.to_dict(include_logo=True))
        cached_pdfs[cache_key] = (pdf_bytes, pdf_sha)
    return cached_pdfs[cache_key]


def clear_all_operational_data(db) -> None:
    """Remove todas as reuniões, ações, versões PDF, links, consentimentos e logs, preservando apenas cidades e admins."""
    db.query(AuditLog).delete()
    db.query(ConsentRecord).delete()
    db.query(PublicLink).delete()
    db.query(MeetingVersion).delete()
    db.query(ActionItem).delete()
    db.query(MeetingIndicator).delete()
    db.query(Meeting).delete()
    db.commit()


def populate_4_months_test_data(db) -> dict[str, int]:
    """Popula 4 meses de reuniões, pendências herdadas, PDFs, links e consentimentos nas 12 cidades."""
    clear_all_operational_data(db)

    admin = db.query(AdminUser).first()
    admin_id = admin.id if admin else None
    admin_name = admin.name if admin else "Administrador LOCAR"

    cities = db.query(City).order_by(City.display_order, City.name).all()
    cached_pdfs: dict[str, tuple[bytes, str]] = {}

    # Distribuição realista de status no último mês (Novembro/2026) pelas 12 cidades
    latest_status_plan = [
        "confirmada",
        "aguardando_confirmacao",
        "link_enviado",
        "rascunho",
        "confirmada",
        "aguardando_confirmacao",
        "confirmada",
        "link_invalido",
        "aguardando_confirmacao",
        "link_enviado",
        "rascunho",
        "confirmada",
    ]

    total_meetings = 0
    total_actions = 0
    total_consents = 0

    for city_idx, city in enumerate(cities):
        prev_meeting: Meeting | None = None

        for m_idx, m_cfg in enumerate(MONTHS_CONFIG):
            meet_date_iso = f"2026-{m_cfg['meet_month']:02d}-{m_cfg['day']:02d}"
            date_text = f"{m_cfg['day']:02d}/{m_cfg['meet_month']:02d}/2026 ({m_cfg['date_suffix']})"
            time_text = f"{9 + (city_idx % 3):02d}:00"
            participants = PARTICIPANTS_POOL[(city_idx + m_idx) % len(PARTICIPANTS_POOL)]

            summary = (
                f"A reunião de indicadores do Contrato {city.name} referente a {m_cfg['ref_label'].lower()} "
                f"apresentou o acompanhamento operacional da unidade, análise de absenteísmo, horas extras, "
                f"disponibilidade de frota, consumo de combustível e alinhamento das entregas do plano de ação."
            )

            topics = [
                {
                    "area": "Pessoas & Operação",
                    "text": f"Quadro ativo estável | Controle de horas extras e absenteísmo em {m_cfg['ref_label']}.",
                },
                {
                    "area": "Frota & Suprimentos",
                    "text": f"Disponibilidade de frota {85 + ((city_idx + m_idx) % 12)}% | Manutenção preventiva em dia.",
                },
            ]

            meeting = Meeting(
                city_id=city.id,
                reference_month=m_cfg["ref_month"],
                reference_label=m_cfg["ref_label"],
                meeting_date=meet_date_iso,
                unit_name_display=city.name,
                local="Microsoft Teams",
                date_text=date_text,
                time_text=time_text,
                participants=participants,
                title=f"Ata de Reunião de Indicadores {m_cfg['ref_label']}",
                summary=summary,
                show_topics=True,
                show_kpis_on_sheet=False,
                header_theme="die",
                primary_color=city.default_primary_color or "#0a7e3a",
                secondary_color=city.default_secondary_color or "#b4c85a",
                density_mode="auto",
                extra_blank_rows=1,
                footer_text=city.default_footer or "DIE – Departamento de Inteligência Estratégica",
                workflow_status="rascunho",
                current_version_number=0,
                is_locked=False,
                created_by=admin_id,
            )
            meeting.set_topics(topics)
            db.add(meeting)
            db.flush()
            total_meetings += 1

            sort_idx = 0
            # Herda pendências da reunião anterior
            if prev_meeting is not None:
                for src in prev_meeting.actions:
                    if not src.checked_completed and src.tracking_status != "concluida":
                        db.add(
                            ActionItem(
                                meeting_id=meeting.id,
                                city_id=city.id,
                                origin_action_id=src.id,
                                action_text=src.action_text,
                                owner=src.owner,
                                deadline=f"Próx. Reunião {m_cfg['next_label']}",
                                status_text="",
                                tracking_status=src.tracking_status or "pendente",
                                checked_completed=False,
                                follow_up_notes=src.follow_up_notes or "",
                                sort_order=sort_idx,
                            )
                        )
                        sort_idx += 1
                        total_actions += 1

            # Adiciona 2 novas ações específicas do mês atual
            for k in range(2):
                tpl_idx = (city_idx * 3 + m_idx * 2 + k) % len(ACTION_TEMPLATES)
                act_text, act_owner = ACTION_TEMPLATES[tpl_idx]
                db.add(
                    ActionItem(
                        meeting_id=meeting.id,
                        city_id=city.id,
                        action_text=f"{act_text} ({m_cfg['ref_label']})",
                        owner=act_owner,
                        deadline=f"Próx. Reunião {m_cfg['next_label']}",
                        status_text="",
                        tracking_status="pendente",
                        checked_completed=False,
                        sort_order=sort_idx,
                    )
                )
                sort_idx += 1
                total_actions += 1

            db.flush()
            db.refresh(meeting)

            # Define progresso realista das ações deste mês (para os meses anteriores conclui ~60%)
            for a_idx, act in enumerate(meeting.actions):
                if m_idx < 3:
                    if (a_idx + city_idx + m_idx) % 2 == 0 or a_idx == 0:
                        act.checked_completed = True
                        act.tracking_status = "concluida"
                        act.checked_at = utcnow_naive() - timedelta(days=20 * (3 - m_idx))
                        act.checked_by = admin_name
                        act.follow_up_notes = "Concluído conforme alinhado em reunião."
                    elif (a_idx + m_idx) % 3 == 0:
                        act.tracking_status = "em_andamento"
                        act.follow_up_notes = "Em andamento com a equipe local."
                else:
                    if a_idx == 0 and city_idx % 2 == 0:
                        act.checked_completed = True
                        act.tracking_status = "concluida"
                        act.checked_at = utcnow_naive()
                        act.checked_by = admin_name
                        act.follow_up_notes = "Validado no mês."
                    elif a_idx == 1:
                        act.tracking_status = "em_andamento"

            # Define estado do fluxo (Agosto/Setembro/Outubro fechados, Novembro variado)
            if m_idx < 2:
                target_status = "confirmada"
            elif m_idx == 2:
                target_status = "confirmada" if city_idx % 4 != 0 else "aguardando_confirmacao"
            else:
                target_status = latest_status_plan[city_idx % len(latest_status_plan)]

            if target_status != "rascunho":
                pdf_bytes, pdf_sha = _make_sample_pdf(meeting, city, cached_pdfs)
                ver = MeetingVersion(
                    meeting_id=meeting.id,
                    city_id=city.id,
                    version_number=1,
                    is_current=True,
                    change_reason="Versão definitiva mensal",
                    snapshot_json="{}",
                    pdf_filename=f"ata_{city.slug}_{m_cfg['ref_month']}_v1.pdf",
                    pdf_content=pdf_bytes,
                    pdf_size_bytes=len(pdf_bytes),
                    pdf_sha256=pdf_sha,
                    generated_by=admin_id,
                    generated_by_name=admin_name,
                    generated_at=utcnow_naive() - timedelta(days=25 * (3 - m_idx)),
                )
                db.add(ver)
                db.flush()

                raw_token = generate_secure_token()
                now = utcnow_naive()
                link_status = "active"
                if target_status == "confirmada":
                    link_status = "used"
                elif target_status == "link_invalido":
                    link_status = "expired"

                link = PublicLink(
                    city_id=city.id,
                    meeting_id=meeting.id,
                    meeting_version_id=ver.id,
                    token_hash=sha256_hex(raw_token),
                    token_encrypted=encrypt_token(raw_token),
                    status=link_status,
                    expires_at=now + timedelta(days=-2 if link_status == "expired" else 30),
                    view_count=2 if target_status in ("aguardando_confirmacao", "confirmada") else 0,
                    first_viewed_at=now - timedelta(days=2) if target_status in ("aguardando_confirmacao", "confirmada") else None,
                    last_viewed_at=now - timedelta(hours=5) if target_status in ("aguardando_confirmacao", "confirmada") else None,
                    used_at=now - timedelta(days=1) if target_status == "confirmada" else None,
                    created_by=admin_id,
                    created_by_name=admin_name,
                    created_at=now - timedelta(days=25 * (3 - m_idx)),
                )
                db.add(link)
                db.flush()

                meeting.current_version_number = 1
                meeting.workflow_status = target_status
                meeting.is_locked = target_status in ("link_enviado", "aguardando_confirmacao", "confirmada")

                if target_status == "confirmada":
                    rep_name = f"Gestor {city.name}"
                    rep_email = f"gestao@{city.slug}.pe.gov.br"
                    accepted_at = now - timedelta(days=22 * (3 - m_idx) + 1)
                    protocol = generate_protocol_code(accepted_at)
                    db.add(
                        ConsentRecord(
                            protocol_code=protocol,
                            city_id=city.id,
                            meeting_id=meeting.id,
                            meeting_version_id=ver.id,
                            public_link_id=link.id,
                            city_name_snapshot=city.name,
                            project_name_snapshot=city.project_name,
                            meeting_title_snapshot=meeting.title,
                            meeting_date_snapshot=meeting.date_text,
                            reference_label_snapshot=meeting.reference_label,
                            version_number_snapshot=1,
                            pdf_filename_snapshot=ver.pdf_filename,
                            pdf_sha256_snapshot=ver.pdf_sha256,
                            representative_name=rep_name,
                            representative_email=rep_email,
                            representative_role="Gestão Municipal / Contrato",
                            consent_declaration="Declaro que li a ata da reunião e confirmo ciência do conteúdo e do plano de ação.",
                            accepted_at=accepted_at,
                            client_ip="127.0.0.1",
                            user_agent="Mozilla/5.0",
                            pdf_viewed_before_consent=True,
                            pdf_downloaded_before_consent=False,
                            integrity_hash=build_consent_integrity_hash(
                                protocol_code=protocol,
                                city_id=city.id,
                                meeting_id=meeting.id,
                                meeting_version_id=ver.id,
                                pdf_sha256=ver.pdf_sha256,
                                representative_name=rep_name,
                                representative_email=rep_email,
                                accepted_at_iso=accepted_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                client_ip="127.0.0.1",
                            ),
                        )
                    )
                    total_consents += 1

            prev_meeting = meeting

    db.commit()
    return {
        "cities": len(cities),
        "meetings": total_meetings,
        "actions": total_actions,
        "consents": total_consents,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Gerar ou limpar dados de teste do sistema LOCAR.")
    parser.add_argument("--populate", action="store_true", help="Gera 4 meses de dados de teste nas 12 cidades.")
    parser.add_argument("--reset", action="store_true", help="Apaga todas as reuniões/ações/links, mantendo apenas as 12 cidades.")
    parser.add_argument("--database-url", default="", help="Opcional: URL do banco de dados alvo.")
    args = parser.parse_args()

    if args.database_url:
        os.environ["LOCAR_DATABASE_URL"] = args.database_url

    from backend.database import SessionLocal, init_db, reconfigure_engine
    from backend.seed import seed_initial_data

    if args.database_url:
        reconfigure_engine(args.database_url)

    init_db()
    db = SessionLocal()
    try:
        seed_initial_data(db)
        if args.populate:
            stats = populate_4_months_test_data(db)
            print(f"Dados de 4 meses gerados: {stats}")
        elif args.reset:
            clear_all_operational_data(db)
            cities_count = db.query(City).count()
            print(f"Sistema limpo! {cities_count} cidades prontas para uso inicial.")
        else:
            parser.print_help()
    finally:
        db.close()


if __name__ == "__main__":
    main()
