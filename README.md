# Grupo LOCAR — Plataforma de Atas de Reunião, PDF Definitivo e Consentimento Público

Sistema web institucional desenvolvido no padrão do **DIE – Departamento de Inteligência Estratégica** da **LOCAR Gestão de Resíduos** para gerenciamento mensal das **12 cidades/projetos de limpeza** do Grupo LOCAR, preservando integralmente a folha A4 original, a leitura de arquivos do Microsoft Teams e todas as exportações existentes.

## Recursos da Plataforma

- **Gestão Multi-Cidades (12 Cidades / Projetos de Limpeza):**
  - Seletor global de cidade/projeto no cabeçalho e **Dashboard Geral do Grupo LOCAR** acompanhando todas as 12 unidades simultaneamente.
  - Módulo dedicado para cadastro, edição de identificação operacional e envio de **logotipo individual** por cidade (exibido automaticamente no cabeçalho A4, PDF definitivo, Word e portal público).
  - Preservação total do histórico cronológico da cidade mesmo ao editar nome ou código do projeto.
- **Preservação Integral do Editor de Ata A4 & Microsoft Teams:**
  - Pré-carregado com **Caruaru — Outubro/2026 (17/11/2026)** e modelo de referência **Vitória de Santo Antão — Abril/2026**.
  - Importação direta de **Relatório de Presença (`.csv` / `.tsv` UTF-16LE/UTF-8)**, **Transcrição (`.txt`, `.vtt`, `.docx` ou texto colado)** e **Planilha de Indicadores (`.csv` / `.tsv` / `.json`)**.
  - Edição lateral e edição direta na folha A4 (`contenteditable`), temas `DIE Oficial` e `Locar Claro`, densidade automática/manual, tabela de Plano de Ação de 4 colunas com coluna **Status vazia por padrão** para preenchimento no papel e linhas extras tracejadas.
  - Exportações preservadas: **Imprimir / PDF (A4)**, **Exportar Word (`.doc`)**, **Salvar JSON** e **Abrir JSON**.
- **Acompanhamento de Melhorias entre Reuniões:**
  - Histórico mensal por cidade com matriz comparativa de indicadores e controle com **check de realização** das ações das reuniões anteriores (sem alterar os PDFs congelados já confirmados).
  - Importação automática ou em 1 clique de ações ainda pendentes para a próxima reunião.
- **PDF Congelado, Link Público Seguro e Consentimento Auditável:**
  - Autenticação administrativa exclusiva para a equipe LOCAR.
  - Geração e congelamento do PDF A4 definitivo vinculado à versão exata da ata (`SHA-256`) armazenado diretamente no banco de dados.
  - Botão **Gerar link para assinatura** criando token criptográfico exclusivo (sem login/senha para representantes das cidades), com controle de validade, revogação manual e bloqueio contra duplicidade.
  - Página pública responsiva (`/ata/<token>`) com visualizador de PDF integrado, download do arquivo original e registro eletrônico auditável de consentimento (sem equivalência automática a assinatura digital qualificada ICP-Brasil).
  - Controle de versões: atas confirmadas ficam bloqueadas contra alterações silenciosas; correções geram nova versão (`v2`, `v3`...), preservando integralmente o PDF e o consentimento anteriores.

## Como Executar Localmente

1. Instale as dependências Python (caso ainda não tenha instalado):
   ```powershell
   pip install -r requirements.txt
   ```
2. Dê dois cliques em `iniciar_sistema.bat` (Windows) **ou** execute:
   ```powershell
   python server.py
   ```
3. Acesse `http://localhost:8080/` (banco local SQLite criado automaticamente em `data/locar_atas.db`).
   - Credenciais iniciais padrão em ambiente local (quando não definidas variáveis de ambiente):
     - **E-mail:** `admin@locar.srv.br`
     - **Senha:** `Locar@2026`
     - *(Altere a senha no botão **Administradores** após o primeiro acesso.)*

## Deploy em Produção no Railway (com PostgreSQL)

Consulte o passo a passo completo no arquivo [DEPLOY_RAILWAY.md](DEPLOY_RAILWAY.md).
