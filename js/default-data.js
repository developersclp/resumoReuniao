// Dados pré-carregados da reunião Indicadores Caruaru (17/11/2026) e modelo de referência (Vitória de Santo Antão - Abril/2026)
window.LOCAR_PRESETS = {
  caruaru_out_2026: {
    id: "caruaru_out_2026",
    label: "Caruaru — Outubro/2026 (17/11/2026)",
    unitName: "Caruaru",
    local: "Microsoft Teams",
    dateText: "17/11/2026 (Terça-Feira)",
    timeText: "09:00",
    participants:
      "Jessica Gomes, Vivian Rodrigues, Belisario, Daniele Torres, Miqueias Moreira, Vitor Arruda, Arthur Borella, Maria Eduarda, Guilherme Godoy, Leonardo Gusmão, Mônica Guerra, Romario de Moura, Daniel Cabral, Álvaro Rangel, Carlos Buarque Filho, Marcela Teixeira, Clécio Rodrigues, Carolina Buarque, Cristiane Santos, Pedro Vitor, Vanessa Belarmino.",
    title: "Ata de Reunião de Indicadores Outubro/2026",
    summary:
      "A reunião de indicadores do Contrato Caruaru referente ao mês de outubro de 2026 apresentou o panorama operacional, financeiro (DRO) e de gestão de pessoas: quadro de 648 colaboradores (turnover 22%, 75% ativos devido a 95 afastados e 64 em férias; defasagem na capina com 48/80 agentes), 3.631 horas extras (R$ 73 mil), absenteísmo por atestados de 2,41% (275 atestados) e faltas de 1,62% (269 faltas), além de 2 acidentes de trabalho. Em frota e suprimentos, foram discutidos o aumento de 12% no gasto de combustível (R$ 406,8 mil) pelo uso de Shellbox, 90 quebras de manutenção (disponibilidade de 86,3%), CPK de pneus em 0,070 e gargalos financeiros com fornecedores (pneus novos, 15 pneus retidos na La Corte, peças hidráulicas, chapas para caixas estacionárias e tacógrafo), bem como 2 ouvidorias em aberto no BI, abertura de rotas no Inlog (71% vs 90% de cobertura GPS) e resultado DRO preliminar de R$ 327 mil (margem de 6,7%).",
    showTopics: true,
    topics: [
      {
        area: "Pessoas & Absenteísmo",
        text: "648 colab. (22% turnover) | 95 afastados (auditoria) | Capina 48/80 | HE: 3.631h (R$ 73 mil) | Atestados: 2,41% (Hub de Atestados) | Faltas: 1,62% (269)."
      },
      {
        area: "Frota, Suprimentos & Segurança",
        text: "2 acidentes | Diesel/Shellbox: R$ 406,8 mil (2,19 km/L) | Manut.: R$ 60,4 mil (90 quebras, 86,3% disp.) | Pneus: CPK 0,070, 2 veículos parados, bloqueio de fornecedores."
      },
      {
        area: "Operação, Ouvidoria & DRO",
        text: "Inlog: 71% abertura | GPS: 90% | Pesagem: 8.310 t | Ouvidoria: 2 em aberto no BI | DRO: Rec. R$ 4,86M, Res. R$ 327 mil (6,7%) | Orçamento 1º Trim/2027."
      }
    ],
    indicators: [
      { label: "Quadro / Ativos", value: "648 (75% ativos)", status: "warn" },
      { label: "Horas Extras", value: "3.631 h / R$ 73 mil", status: "danger" },
      { label: "Atestados / Faltas", value: "2,41% / 1,62%", status: "warn" },
      { label: "Combustível", value: "R$ 406,8 mil (+12%)", status: "warn" },
      { label: "Manutenção / Disp.", value: "R$ 60,4 mil / 86,3%", status: "ok" },
      { label: "CPK Pneus", value: "0,070 (1º lugar)", status: "ok" },
      { label: "Abertura Inlog / GPS", value: "71% / 90%", status: "warn" },
      { label: "DRO (Prévia Out)", value: "R$ 327 mil (6,7%)", status: "ok" }
    ],
    actions: [
      {
        action:
          "Auditoria e levantamento dos 95 afastados (casos antigos de auxílio-doença/INSS) para atualização do quadro",
        owner: "Belisario, Ana Paula e RH",
        deadline: "Próx. Reunião Dezembro/2026",
        status: ""
      },
      {
        action:
          "Implantar acompanhamento no Hub de Atestados (Segurança) e aplicar sanções/alinhamento jurídico para faltas injustificadas",
        owner: "Vivian, Belisario, Marcela, Laet e Ana Paula",
        deadline: "Próx. Reunião Dezembro/2026",
        status: ""
      },
      {
        action:
          "Reforçar seleção com o RH local para recompor efetivo defasado da capina (48 de 80 agentes)",
        owner: "Belisario, Vivian e RH",
        deadline: "Próx. Reunião Dezembro/2026",
        status: ""
      },
      {
        action:
          "Avaliar cenários de redução de horas extras no abastecimento e turno noturno (novo colaborador em curso / escala 12x36)",
        owner: "Vivian, Ezequias e Vitor",
        deadline: "Próx. Reunião Dezembro/2026",
        status: ""
      },
      {
        action:
          "Definir meta/limite de horas extras por contrato e incluir comparativo Quadro Licitação x Atual x Ótimo nos indicadores",
        owner: "Vitor, Jessica e Daniel Cabral",
        deadline: "Próx. Reunião Dezembro/2026",
        status: ""
      },
      {
        action:
          "Monitorar ofensores de atestados (Elizângela Silva no retorno de férias em jan. e aviso prévio de José Ferraz em dez.)",
        owner: "Belisario e RH",
        deadline: "Próx. Reunião Dezembro/2026",
        status: ""
      },
      {
        action:
          "Verificar credenciamento do posto Shell próximo (Av. José Rodrigues de Jesus) no sistema Shellbox",
        owner: "Daniele Torres, Vivian e Belisario",
        deadline: "Próx. Reunião Dezembro/2026",
        status: ""
      },
      {
        action:
          "Priorizar pagamentos via planilha SharePoint: pneus novos, saldo/comprovante La Corte (15 pneus), Jorge Ricardo (hidráulica), chapas e tacógrafo",
        owner: "Carlos Filho, Arthur, Guilherme e Clécio",
        deadline: "Próx. Reunião Dezembro/2026",
        status: ""
      },
      {
        action:
          "Enviar protocolos das 2 ouvidorias em aberto no BI para conferência e baixa pelo contrato",
        owner: "Mônica Guerra, Laís e Vivian",
        deadline: "Próx. Reunião Dezembro/2026",
        status: ""
      },
      {
        action:
          "Retomar reuniões com o tráfego para elevar abertura no Inlog (71% p/ 90%) e revisar cadastro de setores de feira",
        owner: "Jessica, Vivian e Tráfego",
        deadline: "Próx. Reunião Dezembro/2026",
        status: ""
      },
      {
        action:
          "Elaborar orçamento do 1º trimestre de 2027 (ajustes em diesel, insumos operacionais, FGTS consignado e receitas)",
        owner: "Vitor, Daniel Cabral, Pedro Vitor, Vivian e Belisario",
        deadline: "Próx. Reunião Dezembro/2026",
        status: ""
      }
    ],
    footerText: "DIE – Departamento de Inteligência Estratégica",
    extraBlankRows: 1,
    headerTheme: "die"
  },

  vitoria_abr_2026: {
    id: "vitoria_abr_2026",
    label: "Vitória de Santo Antão — Abril/2026 (Modelo Foto)",
    unitName: "Vitória de Santo Antão",
    local: "Microsoft Teams",
    dateText: "26/05/2026 (Terça-Feira)",
    timeText: "10:00",
    participants:
      "Jessica Gomes, Vitor Arruda, Leonardo Uchoa, Alison, Eduardo Ramos, Guilherme Manta, Monica Guerra, Marcela Teixeira, Arthur Borella, Daniel Cabral, Daniele Torres, Miqueias Moreira, Romario Moura, Pedro, Rogerio.",
    title: "Ata de Reunião de Indicadores Abril/2026",
    summary:
      "A reunião de indicadores do Contrato Vitória de Santo Antão referente ao mês de abril de 2026 teve como foco a análise dos resultados operacionais, quadro de colaboradores, horas extras, gestão de férias, afastamentos, atestados e faltas. Também foram discutidos planos de ação para melhoria da disponibilidade operacional, controle de banco de horas e acompanhamento de colaboradores com alto índice de atestados e ausências.",
    showTopics: false,
    topics: [],
    indicators: [
      { label: "Banco de Horas", value: "Encerramento Coletivo", status: "warn" },
      { label: "Ouvidoria em Aberto", value: "Março (01) / Abril (01)", status: "warn" },
      { label: "Manutenção / TOTVS", value: "Treinamento Equipe", status: "ok" }
    ],
    actions: [
      {
        action: "Encerramento Coletivo do Banco de Horas",
        owner: "Vitor",
        deadline: "Prox. Reunião Junho/2026",
        status: ""
      },
      {
        action: "Indicadores – faltas:\nMarcos José (afastado/Jurídico)",
        owner: "Alison e Equipe",
        deadline: "Prox. Reunião Junho/2026",
        status: ""
      },
      {
        action: "Ofício a prefeitura ref ao aumento do Diesel",
        owner: "Alison + Eduardo Laet",
        deadline: "Prox. Reunião Junho/2026",
        status: ""
      },
      {
        action: "Ouvidoria em aberto:\nMarço – 01\nAbril - 01",
        owner: "Alison e Equipe",
        deadline: "Prox. Reunião Junho/2026",
        status: ""
      },
      {
        action: "Treinamento da TOTVS a Equipe de Mecânica (Samuel)",
        owner: "Romário (DTM)",
        deadline: "Prox. Reunião Junho/2026",
        status: ""
      },
      {
        action:
          "Revisar treinamento de rotina do DTM com lançamento da TOTVS para os contratos",
        owner: "Romário (DTM)",
        deadline: "Prox. Reunião Junho/2026",
        status: ""
      }
    ],
    footerText: "DIE – Departamento de Inteligência Estratégica",
    extraBlankRows: 1,
    headerTheme: "die"
  },

  blank: {
    id: "blank",
    label: "Nova Reunião em Branco",
    unitName: "Nome da Filial / Contrato",
    local: "Microsoft Teams",
    dateText: "",
    timeText: "",
    participants: "",
    title: "Ata de Reunião de Indicadores Mês/2026",
    summary:
      "A reunião de indicadores do Contrato teve como foco a análise dos resultados operacionais, quadro de colaboradores, horas extras, atestados, faltas, manutenção, combustível, segurança do trabalho e resultado financeiro (DRO).",
    showTopics: true,
    topics: [],
    indicators: [],
    actions: [
      {
        action: "",
        owner: "",
        deadline: "",
        status: ""
      }
    ],
    footerText: "DIE – Departamento de Inteligência Estratégica",
    extraBlankRows: 2,
    headerTheme: "die"
  }
};
