"""Carga inicial idempotente: Administrador LOCAR e as 12 cidades/projetos de limpeza."""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from backend.config import get_admin_seed_config
from backend.models import ActionItem, AdminUser, City, Meeting, MeetingIndicator
from backend.security import hash_password

logger = logging.getLogger("locar.seed")

CARUARU_PRESET = {
    "reference_month": "2026-10",
    "reference_label": "Outubro/2026",
    "meeting_date": "2026-11-17",
    "unit_name_display": "Caruaru",
    "local": "Microsoft Teams",
    "date_text": "17/11/2026 (Terça-Feira)",
    "time_text": "09:00",
    "participants": (
        "Jessica Gomes, Vivian Rodrigues, Belisario, Daniele Torres, Miqueias Moreira, Vitor Arruda, "
        "Arthur Borella, Maria Eduarda, Guilherme Godoy, Leonardo Gusmão, Mônica Guerra, Romario de Moura, "
        "Daniel Cabral, Álvaro Rangel, Carlos Buarque Filho, Marcela Teixeira, Clécio Rodrigues, "
        "Carolina Buarque, Cristiane Santos, Pedro Vitor, Vanessa Belarmino."
    ),
    "title": "Ata de Reunião de Indicadores Outubro/2026",
    "summary": (
        "A reunião de indicadores do Contrato Caruaru referente ao mês de outubro de 2026 apresentou o "
        "panorama operacional, financeiro (DRO) e de gestão de pessoas: quadro de 648 colaboradores "
        "(turnover 22%, 75% ativos devido a 95 afastados e 64 em férias; defasagem na capina com 48/80 agentes), "
        "3.631 horas extras (R$ 73 mil), absenteísmo por atestados de 2,41% (275 atestados) e faltas de 1,62% "
        "(269 faltas), além de 2 acidentes de trabalho. Em frota e suprimentos, foram discutidos o aumento de "
        "12% no gasto de combustível (R$ 406,8 mil) pelo uso de Shellbox, 90 quebras de manutenção "
        "(disponibilidade de 86,3%), CPK de pneus em 0,070 e gargalos financeiros com fornecedores (pneus novos, "
        "15 pneus retidos na La Corte, peças hidráulicas, chapas para caixas estacionárias e tacógrafo), bem como "
        "2 ouvidorias em aberto no BI, abertura de rotas no Inlog (71% vs 90% de cobertura GPS) e resultado DRO "
        "preliminar de R$ 327 mil (margem de 6,7%)."
    ),
    "show_topics": True,
    "topics": [
        {
            "area": "Pessoas & Absenteísmo",
            "text": (
                "648 colab. (22% turnover) | 95 afastados (auditoria) | Capina 48/80 | "
                "HE: 3.631h (R$ 73 mil) | Atestados: 2,41% (Hub de Atestados) | Faltas: 1,62% (269)."
            ),
        },
        {
            "area": "Frota, Suprimentos & Segurança",
            "text": (
                "2 acidentes | Diesel/Shellbox: R$ 406,8 mil (2,19 km/L) | Manut.: R$ 60,4 mil "
                "(90 quebras, 86,3% disp.) | Pneus: CPK 0,070, 2 veículos parados, bloqueio de fornecedores."
            ),
        },
        {
            "area": "Operação, Ouvidoria & DRO",
            "text": (
                "Inlog: 71% abertura | GPS: 90% | Pesagem: 8.310 t | Ouvidoria: 2 em aberto no BI | "
                "DRO: Rec. R$ 4,86M, Res. R$ 327 mil (6,7%) | Orçamento 1º Trim/2027."
            ),
        },
    ],
    "indicators": [
        {"label": "Quadro / Ativos", "value": "648 (75% ativos)", "status": "warn"},
        {"label": "Horas Extras", "value": "3.631 h / R$ 73 mil", "status": "danger"},
        {"label": "Atestados / Faltas", "value": "2,41% / 1,62%", "status": "warn"},
        {"label": "Combustível", "value": "R$ 406,8 mil (+12%)", "status": "warn"},
        {"label": "Manutenção / Disp.", "value": "R$ 60,4 mil / 86,3%", "status": "ok"},
        {"label": "CPK Pneus", "value": "0,070 (1º lugar)", "status": "ok"},
        {"label": "Abertura Inlog / GPS", "value": "71% / 90%", "status": "warn"},
        {"label": "DRO (Prévia Out)", "value": "R$ 327 mil (6,7%)", "status": "ok"},
    ],
    "actions": [
        {
            "action": "Auditoria e levantamento dos 95 afastados (casos antigos de auxílio-doença/INSS) para atualização do quadro",
            "owner": "Belisario, Ana Paula e RH",
            "deadline": "Próx. Reunião Dezembro/2026",
        },
        {
            "action": "Implantar acompanhamento no Hub de Atestados (Segurança) e aplicar sanções/alinhamento jurídico para faltas injustificadas",
            "owner": "Vivian, Belisario, Marcela, Laet e Ana Paula",
            "deadline": "Próx. Reunião Dezembro/2026",
        },
        {
            "action": "Reforçar seleção com o RH local para recompor efetivo defasado da capina (48 de 80 agentes)",
            "owner": "Belisario, Vivian e RH",
            "deadline": "Próx. Reunião Dezembro/2026",
        },
        {
            "action": "Avaliar cenários de redução de horas extras no abastecimento e turno noturno (novo colaborador em curso / escala 12x36)",
            "owner": "Vivian, Ezequias e Vitor",
            "deadline": "Próx. Reunião Dezembro/2026",
        },
        {
            "action": "Definir meta/limite de horas extras por contrato e incluir comparativo Quadro Licitação x Atual x Ótimo nos indicadores",
            "owner": "Vitor, Jessica e Daniel Cabral",
            "deadline": "Próx. Reunião Dezembro/2026",
        },
        {
            "action": "Monitorar ofensores de atestados (Elizângela Silva no retorno de férias em jan. e aviso prévio de José Ferraz em dez.)",
            "owner": "Belisario e RH",
            "deadline": "Próx. Reunião Dezembro/2026",
        },
        {
            "action": "Verificar credenciamento do posto Shell próximo (Av. José Rodrigues de Jesus) no sistema Shellbox",
            "owner": "Daniele Torres, Vivian e Belisario",
            "deadline": "Próx. Reunião Dezembro/2026",
        },
        {
            "action": "Priorizar pagamentos via planilha SharePoint: pneus novos, saldo/comprovante La Corte (15 pneus), Jorge Ricardo (hidráulica), chapas e tacógrafo",
            "owner": "Carlos Filho, Arthur, Guilherme e Clécio",
            "deadline": "Próx. Reunião Dezembro/2026",
        },
        {
            "action": "Enviar protocolos das 2 ouvidorias em aberto no BI para conferência e baixa pelo contrato",
            "owner": "Mônica Guerra, Laís e Vivian",
            "deadline": "Próx. Reunião Dezembro/2026",
        },
        {
            "action": "Retomar reuniões com o tráfego para elevar abertura no Inlog (71% p/ 90%) e revisar cadastro de setores de feira",
            "owner": "Jessica, Vivian e Tráfego",
            "deadline": "Próx. Reunião Dezembro/2026",
        },
        {
            "action": "Elaborar orçamento do 1º trimestre de 2027 (ajustes em diesel, insumos operacionais, FGTS consignado e receitas)",
            "owner": "Vitor, Daniel Cabral, Pedro Vitor, Vivian e Belisario",
            "deadline": "Próx. Reunião Dezembro/2026",
        },
    ],
    "footer_text": "DIE – Departamento de Inteligência Estratégica",
    "extra_blank_rows": 1,
    "header_theme": "die",
}

VITORIA_PRESET = {
    "reference_month": "2026-04",
    "reference_label": "Abril/2026",
    "meeting_date": "2026-05-26",
    "unit_name_display": "Vitória de Santo Antão",
    "local": "Microsoft Teams",
    "date_text": "26/05/2026 (Terça-Feira)",
    "time_text": "10:00",
    "participants": (
        "Jessica Gomes, Vitor Arruda, Leonardo Uchoa, Alison, Eduardo Ramos, Guilherme Manta, "
        "Monica Guerra, Marcela Teixeira, Arthur Borella, Daniel Cabral, Daniele Torres, "
        "Miqueias Moreira, Romario Moura, Pedro, Rogerio."
    ),
    "title": "Ata de Reunião de Indicadores Abril/2026",
    "summary": (
        "A reunião de indicadores do Contrato Vitória de Santo Antão referente ao mês de abril de 2026 teve "
        "como foco a análise dos resultados operacionais, quadro de colaboradores, horas extras, gestão de férias, "
        "afastamentos, atestados e faltas. Também foram discutidos planos de ação para melhoria da "
        "disponibilidade operacional, controle de banco de horas e acompanhamento de colaboradores com alto "
        "índice de atestados e ausências."
    ),
    "show_topics": False,
    "topics": [],
    "indicators": [
        {"label": "Banco de Horas", "value": "Encerramento Coletivo", "status": "warn"},
        {"label": "Ouvidoria em Aberto", "value": "Março (01) / Abril (01)", "status": "warn"},
        {"label": "Manutenção / TOTVS", "value": "Treinamento Equipe", "status": "ok"},
    ],
    "actions": [
        {
            "action": "Encerramento Coletivo do Banco de Horas",
            "owner": "Vitor",
            "deadline": "Prox. Reunião Junho/2026",
        },
        {
            "action": "Indicadores – faltas:\nMarcos José (afastado/Jurídico)",
            "owner": "Alison e Equipe",
            "deadline": "Prox. Reunião Junho/2026",
        },
        {
            "action": "Ofício a prefeitura ref ao aumento do Diesel",
            "owner": "Alison + Eduardo Laet",
            "deadline": "Prox. Reunião Junho/2026",
        },
        {
            "action": "Ouvidoria em aberto:\nMarço – 01\nAbril - 01",
            "owner": "Alison e Equipe",
            "deadline": "Prox. Reunião Junho/2026",
        },
        {
            "action": "Treinamento da TOTVS a Equipe de Mecânica (Samuel)",
            "owner": "Romário (DTM)",
            "deadline": "Prox. Reunião Junho/2026",
        },
        {
            "action": "Revisar treinamento de rotina do DTM com lançamento da TOTVS para os contratos",
            "owner": "Romário (DTM)",
            "deadline": "Prox. Reunião Junho/2026",
        },
    ],
    "footer_text": "DIE – Departamento de Inteligência Estratégica",
    "extra_blank_rows": 1,
    "header_theme": "die",
}


def _create_meeting_from_preset(db: Session, city: City, preset: dict, admin_id: str | None) -> Meeting:
    meeting = Meeting(
        city_id=city.id,
        reference_month=preset["reference_month"],
        reference_label=preset["reference_label"],
        meeting_date=preset["meeting_date"],
        unit_name_display=preset["unit_name_display"],
        local=preset["local"],
        date_text=preset["date_text"],
        time_text=preset["time_text"],
        participants=preset["participants"],
        title=preset["title"],
        summary=preset["summary"],
        show_topics=preset["show_topics"],
        show_kpis_on_sheet=False,
        header_theme=preset["header_theme"],
        density_mode="auto",
        extra_blank_rows=preset["extra_blank_rows"],
        footer_text=preset["footer_text"],
        workflow_status="rascunho",
        current_version_number=0,
        is_locked=False,
        created_by=admin_id,
    )
    meeting.set_topics(preset.get("topics", []))
    db.add(meeting)
    db.flush()

    for idx, ind in enumerate(preset.get("indicators", [])):
        db.add(
            MeetingIndicator(
                meeting_id=meeting.id,
                city_id=city.id,
                label=ind["label"],
                value=ind["value"],
                status=ind.get("status", "ok"),
                sort_order=idx,
            )
        )

    for idx, act in enumerate(preset.get("actions", [])):
        db.add(
            ActionItem(
                meeting_id=meeting.id,
                city_id=city.id,
                action_text=act["action"],
                owner=act["owner"],
                deadline=act["deadline"],
                status_text="",
                tracking_status="pendente",
                checked_completed=False,
                sort_order=idx,
            )
        )

    return meeting


def seed_initial_data(db: Session) -> None:
    """Inicializa administrador padrão e as 12 cidades/projetos do Grupo LOCAR de forma idempotente."""
    admin_user = db.query(AdminUser).first()
    if not admin_user:
        cfg = get_admin_seed_config()
        admin_user = AdminUser(
            name=cfg["name"],
            email=cfg["email"],
            password_hash=hash_password(cfg["password"]),
            role="admin",
            is_active=True,
        )
        db.add(admin_user)
        db.flush()
        logger.info("Administrador inicial LOCAR criado para o e-mail: %s", cfg["email"])

    existing_cities = db.query(City).count()
    if existing_cities == 0:
        caruaru = City(
            slug="caruaru",
            name="Caruaru",
            project_name="Limpeza Urbana e Coleta de Resíduos — Caruaru",
            project_code="LOCAR-01",
            state_uf="PE",
            institutional_info="Projeto operacional de limpeza pública e manejo de resíduos urbanos em Caruaru/PE.",
            default_local="Microsoft Teams",
            default_footer="DIE – Departamento de Inteligência Estratégica",
            display_order=1,
            is_active=True,
        )
        vitoria = City(
            slug="vitoria-de-santo-antao",
            name="Vitória de Santo Antão",
            project_name="Limpeza Urbana e Coleta de Resíduos — Vitória de Santo Antão",
            project_code="LOCAR-02",
            state_uf="PE",
            institutional_info="Projeto operacional de limpeza pública e coleta de resíduos em Vitória de Santo Antão/PE.",
            default_local="Microsoft Teams",
            default_footer="DIE – Departamento de Inteligência Estratégica",
            display_order=2,
            is_active=True,
        )
        db.add(caruaru)
        db.add(vitoria)
        db.flush()

        _create_meeting_from_preset(db, caruaru, CARUARU_PRESET, admin_user.id)
        _create_meeting_from_preset(db, vitoria, VITORIA_PRESET, admin_user.id)

        for num in range(3, 13):
            code = f"LOCAR-{num:02d}"
            city = City(
                slug=f"cidade-{num:02d}",
                name=f"Cidade / Projeto {num:02d}",
                project_name=f"Projeto de Limpeza Urbana — Unidade {num:02d}",
                project_code=code,
                state_uf="PE",
                institutional_info="Unidade operacional do Grupo LOCAR. Edite o nome oficial, código e logotipo no módulo Cidades / Projetos.",
                default_local="Microsoft Teams",
                default_footer="DIE – Departamento de Inteligência Estratégica",
                display_order=num,
                is_active=True,
            )
            db.add(city)

    db.commit()
