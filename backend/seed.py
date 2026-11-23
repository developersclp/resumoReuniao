"""Carga inicial idempotente: Administrador LOCAR e as 12 cidades/projetos de limpeza."""

from __future__ import annotations

import logging
import unicodedata

from sqlalchemy.orm import Session

from backend.config import get_admin_seed_config
from backend.models import (
    ActionItem,
    AdminUser,
    City,
    ConsentRecord,
    Meeting,
    MeetingIndicator,
    MeetingVersion,
    PublicLink,
)
from backend.security import hash_password

logger = logging.getLogger("locar.seed")

OFFICIAL_CITIES = [
    {"order": 1, "slug": "cabo-de-santo-agostinho", "name": "Cabo de Santo Agostinho", "uf": "PE", "code": "LOCAR-01"},
    {"order": 2, "slug": "jaboatao-dos-guararapes", "name": "Jaboatão dos Guararapes", "uf": "PE", "code": "LOCAR-02"},
    {"order": 3, "slug": "olinda", "name": "Olinda", "uf": "PE", "code": "LOCAR-03"},
    {"order": 4, "slug": "paulista", "name": "Paulista", "uf": "PE", "code": "LOCAR-04"},
    {"order": 5, "slug": "caruaru", "name": "Caruaru", "uf": "PE", "code": "LOCAR-05"},
    {"order": 6, "slug": "cuiaba", "name": "Cuiabá", "uf": "MT", "code": "LOCAR-06"},
    {"order": 7, "slug": "garanhuns", "name": "Garanhuns", "uf": "PE", "code": "LOCAR-07"},
    {"order": 8, "slug": "pesqueira", "name": "Pesqueira", "uf": "PE", "code": "LOCAR-08"},
    {"order": 9, "slug": "vitoria-de-santo-antao", "name": "Vitória de Santo Antão", "uf": "PE", "code": "LOCAR-09"},
    {"order": 10, "slug": "canela", "name": "Canela", "uf": "RS", "code": "LOCAR-10"},
    {"order": 11, "slug": "jequie", "name": "Jequié", "uf": "BA", "code": "LOCAR-11"},
    {"order": 12, "slug": "novo-hamburgo", "name": "Novo Hamburgo", "uf": "RS", "code": "LOCAR-12"},
]


def _norm_city_name(value: str) -> str:
    nfkd = unicodedata.normalize("NFKD", (value or "").strip().lower())
    return "".join(ch for ch in nfkd if not unicodedata.combining(ch))

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


def _build_city_record(spec: dict) -> City:
    return City(
        slug=spec["slug"],
        name=spec["name"],
        project_name=f"Limpeza Urbana e Coleta de Resíduos — {spec['name']}",
        project_code=spec["code"],
        state_uf=spec["uf"],
        institutional_info=f"Unidade operacional do Grupo LOCAR — {spec['name']}/{spec['uf']}.",
        default_local="Microsoft Teams",
        default_footer="DIE – Departamento de Inteligência Estratégica",
        display_order=spec["order"],
        is_active=True,
    )


def seed_initial_data(db: Session) -> None:
    """Inicializa administrador padrão e as 12 cidades oficiais do Grupo LOCAR de forma idempotente."""
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

    existing_cities = db.query(City).order_by(City.display_order, City.created_at).all()
    if len(existing_cities) == 0:
        for spec in OFFICIAL_CITIES:
            city = _build_city_record(spec)
            db.add(city)
        db.flush()
        logger.info("12 Cidades oficiais do Grupo LOCAR cadastradas com sucesso para uso inicial limpo.")
    else:
        # Sincroniza de forma idempotente bancos que tinham placeholders (Cidade / Projeto 03..12)
        by_slug = {c.slug: c for c in existing_cities}
        by_norm_name = {_norm_city_name(c.name): c for c in existing_cities}
        official_slugs = {s["slug"] for s in OFFICIAL_CITIES}
        official_names = {_norm_city_name(s["name"]) for s in OFFICIAL_CITIES}

        placeholders = [
            c
            for c in existing_cities
            if (c.slug.startswith("cidade-") or (c.name or "").startswith("Cidade / Projeto"))
            and c.slug not in official_slugs
            and _norm_city_name(c.name) not in official_names
        ]
        placeholders.sort(key=lambda c: (len(c.meetings), c.display_order))

        for spec in OFFICIAL_CITIES:
            match = by_slug.get(spec["slug"]) or by_norm_name.get(_norm_city_name(spec["name"]))
            if match:
                match.display_order = spec["order"]
                if not match.state_uf:
                    match.state_uf = spec["uf"]
                # Atualiza código padrão antigo do seed (LOCAR-01/LOCAR-02 em Caruaru/Vitória) sem tocar códigos customizados
                if match.slug == "caruaru" and match.project_code == "LOCAR-01":
                    match.project_code = spec["code"]
                elif match.slug == "vitoria-de-santo-antao" and match.project_code == "LOCAR-02":
                    match.project_code = spec["code"]
                continue

            if placeholders:
                target = placeholders.pop(0)
                target.slug = spec["slug"]
                target.name = spec["name"]
                target.project_name = f"Limpeza Urbana e Coleta de Resíduos — {spec['name']}"
                target.project_code = spec["code"]
                target.state_uf = spec["uf"]
                target.institutional_info = f"Unidade operacional do Grupo LOCAR — {spec['name']}/{spec['uf']}."
                target.display_order = spec["order"]
                by_slug[target.slug] = target
                by_norm_name[_norm_city_name(target.name)] = target
            else:
                new_city = _build_city_record(spec)
                db.add(new_city)
                db.flush()
                by_slug[new_city.slug] = new_city
                by_norm_name[_norm_city_name(new_city.name)] = new_city

    # Limpeza de demonstrações pré-existentes (deixando o sistema 100% limpo com apenas as 12 cidades)
    demo_titles = [
        "Ata de Reunião de Indicadores Outubro/2026",
        "Ata de Reunião de Indicadores Abril/2026",
    ]
    demo_meetings = db.query(Meeting).filter(Meeting.title.in_(demo_titles)).all()
    if demo_meetings:
        demo_ids = [m.id for m in demo_meetings]
        db.query(ConsentRecord).filter(ConsentRecord.meeting_id.in_(demo_ids)).delete(synchronize_session=False)
        db.query(PublicLink).filter(PublicLink.meeting_id.in_(demo_ids)).delete(synchronize_session=False)
        db.query(MeetingVersion).filter(MeetingVersion.meeting_id.in_(demo_ids)).delete(synchronize_session=False)
        db.query(ActionItem).filter(ActionItem.meeting_id.in_(demo_ids)).delete(synchronize_session=False)
        db.query(MeetingIndicator).filter(MeetingIndicator.meeting_id.in_(demo_ids)).delete(synchronize_session=False)
        db.query(Meeting).filter(Meeting.id.in_(demo_ids)).delete(synchronize_session=False)
        db.flush()
        logger.info("Reuniões de demonstração/preset removidas: sistema 100% limpo.")

    db.commit()
