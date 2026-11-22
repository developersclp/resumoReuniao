# Passo a Passo de Deploy no Railway — Plataforma Grupo LOCAR

Este guia explica exatamente como subir a plataforma do **Grupo LOCAR (12 Cidades/Projetos de Limpeza)** no **Railway** com **PostgreSQL**, geração de PDF A4 definitiva no servidor e links públicos de consentimento.

---

## 1. Sobre o Banco de Dados e Armazenamento no Railway

**Sim, em produção no Railway é obrigatório adicionar o banco de dados PostgreSQL** ao projeto:

- **Por que o PostgreSQL é necessário?**
  No Railway, o sistema de arquivos do container da aplicação é **efêmero** (todo arquivo salvo apenas em disco local do container é perdido a cada novo deploy ou reinício).
- **Como o sistema resolve a persistência sem custo extra de Volume?**
  - **Localmente** (no seu computador com `iniciar_sistema.bat` ou `python server.py`), o sistema cria e usa automaticamente o banco SQLite em `data/locar_atas.db`.
  - **No Railway**, quando a variável `DATABASE_URL` do PostgreSQL está conectada, todas as tabelas (administradores, as **12 cidades/projetos**, reuniões mensais, indicadores, plano de ação, checks de acompanhamento, versões congeladas em PDF, tokens públicos, registros auditáveis de consentimento e logs de auditoria) são gravadas automaticamente no **PostgreSQL** — incluindo os **binários dos PDFs congelados (`BYTEA`)** e os **logotipos individuais das cidades**.
  - **Você NÃO precisa criar Railway Volume**, pois nenhum PDF definitivo ou logotipo depende de disco local em produção.
  - As tabelas e os registros iniciais (administrador inicial + as 12 cidades/projetos, incluindo Caruaru Outubro/2026 e Vitória de Santo Antão Abril/2026) são criados automaticamente na primeira inicialização da aplicação (`bootstrap_database`), de forma idempotente.

---

## 2. Preparação do Repositório no GitHub

No diretório do projeto (`c:\Users\User\resumoReuniao`), envie as alterações para o seu repositório GitHub:

```powershell
git add .
git commit -m "Plataforma Grupo LOCAR: 12 cidades/projetos, PDF congelado e consentimento publico"
git push origin main
```

---

## 3. Criação do Projeto e Banco PostgreSQL no Railway

1. Acesse [railway.com](https://railway.com) e faça login.
2. Clique em **+ New Project** -> **Deploy from GitHub repo** e selecione o repositório `resumoReuniao`.
3. Aguarde a criação do serviço da aplicação web.
4. Dentro do mesmo projeto no Railway, clique em **+ New** -> **Database** -> **Add PostgreSQL**.
5. Aguarde o serviço **Postgres** inicializar (status *Online*).

---

## 4. Configuração das Variáveis de Ambiente (Obrigatório)

Abra o serviço da aplicação web (`resumoReuniao`), vá na aba **Variables** e adicione as variáveis abaixo:

| Variável | Valor Recomendado | Obrigatória? | Finalidade |
|---|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | **Sim** | Conecta a aplicação ao PostgreSQL criado no passo 3 |
| `APP_SECRET_KEY` | String aleatória forte (mín. 48 caracteres) | **Sim** | Criptografa tokens dos links públicos e protege a integridade da aplicação |
| `ADMIN_EMAIL` | Ex: `die@locar.srv.br` | **Sim** | E-mail do administrador inicial da LOCAR criado no 1º boot |
| `ADMIN_PASSWORD` | Senha forte exclusiva | **Sim** | Senha inicial do administrador LOCAR |
| `ADMIN_NAME` | Ex: `Administrador DIE LOCAR` | Recomendada | Nome exibido nos logs e versões geradas |
| `PUBLIC_BASE_URL` | Ex: `https://seu-dominio.up.railway.app` | Opcional | Domínio público base usado ao gerar o link de consentimento (se omitido, detecta automaticamente pelo cabeçalho da requisição) |
| `DEFAULT_LINK_DAYS` | `30` | Opcional | Validade padrão em dias dos links públicos gerados |
| `SESSION_TTL_HOURS` | `24` | Opcional | Duração da sessão administrativa em horas |

### Como gerar uma `APP_SECRET_KEY` segura no Windows (PowerShell):

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Copie a string gerada e cole como valor de `APP_SECRET_KEY` no Railway.

---

## 5. Build com Dockerfile (Chromium + Fontes) e Healthcheck

O arquivo `railway.json` já está configurado para construir via **Dockerfile**:

- Instala Python 3.11 + `Flask`, `SQLAlchemy`, `psycopg2-binary`, `gunicorn`, `cryptography`, `Werkzeug`.
- Instala o **Chromium** (`chromium`) e a fonte **Carlito** (`fonts-carlito`, com métricas equivalentes à Calibri) para garantir que os PDFs A4 definitivos gerados no servidor fiquem com alinhamento, tipografia, cabeçalho orgânico e tabela de 4 colunas idênticos à folha A4 exibida no navegador.
- Inicia via `gunicorn` na porta `$PORT` fornecida pelo Railway.
- Usa `/health` como endpoint de verificação de saúde (`healthcheckPath`).

Se o build inicial tiver sido disparado antes de você adicionar as variáveis (`DATABASE_URL`, `APP_SECRET_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`), após salvar as variáveis clique em **Deploy** -> **Redeploy** no serviço da aplicação.

---

## 6. Gerar Domínio Público

1. No serviço da aplicação web no Railway, acesse a aba **Settings**.
2. Em **Networking** -> **Public Networking**, clique em **Generate Domain** (ex: `https://locar-atas.up.railway.app`).
3. Caso configure `PUBLIC_BASE_URL`, cole exatamente essa URL HTTPS (sem barra `/` no final).

---

## 7. Checklist de Validação Pós-Deploy

1. **Verificar `/health`**:
   Abra `https://<seu-dominio>/health` no navegador. O retorno esperado é semelhante a:
   ```json
   {
     "status": "ok",
     "service": "locar-atas-plataforma",
     "database": "postgresql",
     "database_ok": true,
     "pdf_engine": "chromium"
   }
   ```
   Confirme que `"database": "postgresql"`, `"database_ok": true` e `"pdf_engine": "chromium"`.

2. **Acessar o Painel Administrativo**:
   - Abra `https://<seu-dominio>/`.
   - Faça login com `ADMIN_EMAIL` e `ADMIN_PASSWORD` configurados no passo 4.
   - Confirme no **Dashboard Geral** que as 12 cidades/projetos aparecem listadas (com Caruaru e Vitória de Santo Antão pré-carregadas).

3. **Configurar as 12 Cidades/Projetos e Logotipos**:
   - Acesse **Cidades / Projetos** e edite o nome oficial, código e logotipo individual de cada uma das 12 cidades/projetos.

4. **Testar Fluxo Completo Ponta a Ponta**:
   - No **Editor da Ata (A4)**, selecione uma cidade e abra ou crie uma reunião.
   - Clique em **Finalizar Ata (PDF)** para congelar a versão `v1`.
   - Clique em **Gerar link para assinatura** e copie o link público.
   - Abra o link em uma **janela anônima** ou no **celular** (sem estar logado como administrador):
     - Confirme que a página pública exibe identificação da LOCAR, cidade/projeto, data, período de referência, visualizador integral do PDF e botão **Baixar PDF original**.
     - Preencha nome completo, e-mail, marque a caixa de leitura e concordância e clique em **Confirmar e registrar consentimento**.
   - Volte ao painel administrativo e verifique que a situação foi atualizada automaticamente para **Confirmada**, com registro auditável completo disponível em **Versões / Auditoria**.

---

## 8. Troubleshooting Rápido

- **Login não entra ou dá erro de credencial no 1º acesso**:
  - Verifique se `ADMIN_EMAIL` e `ADMIN_PASSWORD` foram configurados **antes** do primeiro boot com o PostgreSQL conectado. Caso o primeiro boot tenha criado com o valor padrão antes de configurar as variáveis, entre com `admin@locar.srv.br` / `Locar@2026` e altere a senha no botão **Administradores** no topo.
- **Healthcheck reportando `"database": "sqlite"` no Railway**:
  - A variável `DATABASE_URL` não está referenciando `${{Postgres.DATABASE_URL}}` no serviço web. Adicione a referência e faça Redeploy.
- **Link público gerado com `http://` em vez de `https://`**:
  - Defina a variável `PUBLIC_BASE_URL=https://<seu-dominio-railway>` na aba **Variables** (o servidor já utiliza `ProxyFix` para respeitar `X-Forwarded-Proto`, mas definir `PUBLIC_BASE_URL` garante o domínio canônico).
- **Backup do Banco de Dados**:
  - Ative os backups automáticos do PostgreSQL no painel do serviço **Postgres** no Railway (**Backups**).
