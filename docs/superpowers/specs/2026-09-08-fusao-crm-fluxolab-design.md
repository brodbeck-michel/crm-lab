# Spec — Fusão CRM Lab + FluxoLab: um produto único

**Data:** 2026-09-08
**Revisão 2:** 2026-09-12 — remove a divisão Basic/Plus; troca o alvo de hospedagem para VPS
Hostinger; renumera ondas e migrações; funde as colunas de conciliação na migração do domínio LIS.
**Origem:** decisão do lead de unir o CRM (em validação, quase pronto) ao FluxoLab (painel de
orçamentos do Laboratório Santé, em produção na Vercel + Supabase `nxgpdaoeaafkfwzpyxap`).
**Status:** aprovada no desenho; ondas 9–13 ainda não iniciadas.
**Estado de partida:** CRM Lab em `49c369e` (v1.4.0). Migrações aplicadas até
`011_proposal_number.sql`. `LAB_ROUTES` com **72 rotas**. FluxoLab em `03f3e16`.

---

## 0. O que mudou na revisão 2 (e por quê)

| Decisão anterior | Agora | Motivo |
|---|---|---|
| Planos `basic` / `plus` com entitlement no JWT | **Produto único, tudo liberado** | Gating é camada aditiva: um middleware + um campo opcional em `route-config`. Adiar não cria dívida e apaga a Onda 9 inteira (~2–3 agent-days). |
| Hospedagem em VPS genérica + Caddy | **VPS Hostinger KVM 2, região São Paulo** | Evolution API e o hub de WebSocket exigem processo always-on — Vercel está descartada por impossibilidade técnica, não por preferência. São Paulo reduz latência para os usuários do Santé e mantém `patient_name` em território nacional. |
| Migrações `010`–`013` | **`012_lis_domain.sql` + `013_rls_lis_domain.sql`** | A numeração do spec original estava obsoleta: o repo já tem migrações até `011`. |
| Colunas `lis_*` em `proposals` numa migração separada (Onda 14) | **Entram já na `012`** | Sem separação de plano, não há motivo para duas migrações e dois passes pelo `ProposalService`. As colunas nascem juntas; o comportamento continua na última onda. |
| 6 ondas (9–14), ~34 agent-days | **5 ondas (9–13), ~31,5 agent-days** | Consequência da remoção da Onda 9 original. |

O que **não** mudou: a decisão de reimplementar o FluxoLab dentro do CRM (Express + Postgres +
RLS + `@crm-lab/shared` + testes), congelando o FluxoLab após o cutover. Não há SSO entre dois
apps, não se mantém o Supabase.

---

## 1. Contexto e objetivo

Dois produtos do mesmo domínio, em pontas opostas do mesmo processo. O **CRM Lab** produz o
orçamento (WhatsApp → proposta → pipeline). O **FluxoLab** lê o resultado (planilha do LIS →
requisição → valor pago → KPIs, Busca Ativa, comissão). O FluxoLab é, na prática, a "Trilha C"
(conciliação orçamento → requisição → baixa) que o CRM esperava da integração com o Bitlab,
feita por planilha em vez de API.

O objetivo é **um único produto**, com todas as funcionalidades disponíveis a todo tenant:

- **Herdado do FluxoLab:** importação de planilha do LIS, Resultados, Conferência, Busca Ativa,
  Vendas + comissão, Relatório executivo PDF, cadastro de atendentes.
- **Herdado do CRM:** WhatsApp, atendimento, propostas, pipeline, convênios com preço, catálogo
  de exames, chat interno, analytics.
- **Novo:** conciliação automática proposta ↔ LIS.

O acesso continua governado por **papel** (`admin` / `manager` / `attendant`), que já existe e é
testado. Não há segunda dimensão de autorização.

### Sobre planos: adiado, não descartado

`tenants.subscription_plan` (VARCHAR sem CHECK, default `starter`) permanece **como está** — só é
lido por `PlatformService` para listar e faturar. Não se cria `requirePlan`, `PLAN_FEATURES`,
`PLAN_REQUIRED` nem `JwtPayload.plan` nesta v1.

Isso é seguro porque entitlement por plano é **aditivo**: quando for a hora, entra como um
middleware no kernel ao lado de `requireRoles` e um campo `requiredPlan?` em `AppRoute`. Nenhuma
tabela, serviço ou tela construída nas ondas 9–13 precisa mudar para acomodá-lo. **D-108.**

### O que existe hoje (verificado no código, não suposto)

| Ponto | CRM Lab | FluxoLab |
|---|---|---|
| Requisição / valor pago / importação de planilha / vendas | **Não existe.** `/analytics/*` lê só `proposals`. | É o núcleo: `orcamentos`, `importacoes`, `vendas` |
| Multitenancy | 3 camadas + RLS provada por teste (72 rotas em `LAB_ROUTES`) | **Zero.** 7 tabelas sem tenant, `numero` UNIQUE global, "Santé" hardcoded |
| Atendente | É um `users.role = 'attendant'` com login | É um **nome** (`USUÁRIO` da planilha, `atendentes.nome`, `profiles.atendente`) |
| Comissão | — | Percentuais em `localStorage` (2 / 1,5 / 1,5), por navegador |
| KPIs | SQL no backend | Tabela inteira no navegador + `useMemo` |
| Senha | bcrypt (`bcryptjs`) | bcrypt (`crypt/gen_salt('bf')`) — hashes compatíveis |
| Upload de arquivo | base64 dentro do JSON, teto no serviço (Onda 8; **sem multer**) | SheetJS no navegador |
| Testes | ~1.700 | 0 |

Regras do FluxoLab validadas em produção e que **devem ser preservadas** (referência:
`git show HEAD:src/lib/orcamento.ts` e `HEAD:src/lib/executiveReport.ts` no repo antigo):

- dedupe por número (maior total vence); dedupe por requisição (maior `valor_pago` vence);
- convênio principal = primeiro de c1..c3 com nome **e** valor > 0; senão primeiro com nome;
- conversão capada em 100%; `MIN_ORC_RANKING = 20` para rankings qualitativos;
- duas janelas de tempo: emissão (orçado, requisição) vs pagamento (recebido);
- colunas da planilha: `ORCAMENTO` (obrigatória), `DATA_ORÇAMENTO`, `NM_PACIENTE`, `CONVENIO1..3`,
  `VL_TOTAL1..3`, `USUÁRIO`/`USUARIO`, `MEDIA_CONVENIO`, `REQUISICAO` (5 aliases),
  `VALOR_REQUISICAO`, `Valor_Pago` (3 aliases), `DATA_PAGAMENTO` (5 aliases); guard `%PDF`;
  serial Excel → data por componentes, sem fuso.

### Decisões do lead — não renegociar

1. **Reimplementar o FluxoLab dentro do CRM Lab.** FluxoLab é congelado após o cutover.
2. **Produto único, sem planos na v1** (D-108).
3. **Conciliação:** a atendente digita o **nº do orçamento do LIS** na proposta; a importação casa
   por `(tenant_id, número)`. Requisição encontrada → proposta vai para `ganho` automaticamente;
   pagamento só grava valor/data.
4. **Hospedagem:** VPS única na Hostinger (KVM 2, São Paulo) rodando `docker-compose.prod.yml` +
   Caddy na borda. Domínio único, tenant sempre pelo JWT, sem subdomínio. **D-121.**
5. **Cutover do Santé:** operação paralela 1–2 semanas com checklist de paridade → antigo em
   somente leitura → fora do ar.
6. **Ordem:** migrar o Santé e estabilizar **antes** de construir a conciliação.
7. **Planilha sempre `.xlsx`** → `exceljs` no backend (sem advisories; não lê `.xls`).
8. **Senhas migram como estão** (bcrypt nos dois lados).
9. **Upload de planilha em base64 no JSON**, como a Onda 8 (`media.service.ts:4-6`). Planilha real
   do Santé ≈ 500KB → ≈ 667KB em base64, folgado dentro do teto.
10. **Fluxo de trabalho: local → GitHub → produção.** Ondas 9, 10 e 13 são inteiramente locais.

---

## 2. Arquitetura alvo

### 2.1 Domínio "Orçamentos do LIS"

Tabelas novas, todas com `tenant_id` + policy RLS no mesmo par de migrações:

- **`attendants`** — `name`, `folded_name` (gerada: `lower` + espaços colapsados), `is_active`,
  `user_id` opcional (`UNIQUE (tenant_id, user_id)`), `UNIQUE (tenant_id, folded_name)`.
  O `USUÁRIO` da planilha vira `attendant_id`; ligar `user_id` é opcional e manual. **D-112.**
- **`lis_imports`** — histórico imutável: `kind import|purge`, `file_name`, `rows_in_file`,
  `rows_accepted`, `rows_rejected`, `proposals_won`, `status processing|completed|failed`,
  `error_message`, `created_by`, `finished_at`. Sem DELETE na API.
- **`lis_budgets`** — 1 linha por `UNIQUE (tenant_id, number)`: `issued_on DATE`,
  `patient_name`, `insurance_1..3` + `value_1..3`, colunas geradas STORED
  `principal_insurance_name` e `total_value` (regra do convênio principal), `insurance_id`
  resolvido (NULL = particular, D-082), `attendant_name` + `attendant_id`, `insurance_average`,
  `requisition_number`, `requisition_value`, `paid_value`, `paid_on DATE`, `import_id`,
  `proposal_id` nullable. Índices por `(tenant_id, issued_on)`, `(tenant_id, paid_on)
  WHERE paid_value > 0`, `(tenant_id, requisition_number)`, `(tenant_id, attendant_id)`.
- **`sales`** — `attendant_id`, `sold_on DATE`, `code`, `value > 0`, `exams` (texto),
  `kind exams|checkup`, `created_by`.
- **`tenant_settings`** ganha `commission_budget_pct` (2,00), `commission_exams_pct` (1,50),
  `commission_checkup_pct` (1,50). **D-113.**
- **`insurances`** ganha `type = 'outro'` no CHECK e `source manual|lis`.
- **`proposals`** ganha `lis_budget_number` (índice único parcial por tenant),
  `lis_requisition_number`, `lis_paid_value`, `lis_paid_on`, `lis_reconciled_at` — **criadas já
  aqui**, populadas só na Onda 13. **D-118.**

Escolhas de modelagem:

- Datas do LIS são `DATE`, não `TIMESTAMP` (o serial do Excel não tem fuso; todo agrupamento é por
  dia/mês; elimina a classe de bug de UTC-3). **D-110.**
- Colunas `GENERATED … STORED` para `principal_insurance_name` e `total_value`. **D-111.**
- Convênio da planilha é resolvido por nome dobrado em `insurances`; inexistente é **criado**
  com `type='outro'`, `source='lis'`. `PARTICULAR` e variantes → `insurance_id NULL`. O nome
  bruto fica em `insurance_1..3`. **D-114.**
- Exames do FluxoLab entram em `exam_catalog` com `price_private = 0`, `price_insurance = 0`,
  `source='lis'`; sinônimos em `exam_synonyms`. A UI do Catálogo marca "sem preço". **D-115.**

**Import:** `POST /lis-imports { fileName, contentBase64 }` → parser puro em
`backend/src/lib/lis-spreadsheet.ts` (exceljs; guard `%PDF`; exige `ORCAMENTO`; mesmos aliases)
→ `consolidateByNumber` (port de `consolidateOrcamentos`) → resolve atendentes e convênios →
upsert `ON CONFLICT (tenant_id, number)` em chunks → status + `audit.record` + invalidação de
cache `lis:<tenant>:`. Erro de planilha → `VALIDATION_ERROR` com `details.reason`
(`pdf_disguised | missing_column | empty`). Purge (admin) apaga `lis_budgets` do tenant e registra
`lis_imports(kind='purge')`. **D-109.**

**KPIs em SQL** (`lis-analytics.repository.ts`): CTEs `issued` (janela de emissão),
`req` (`DISTINCT ON (requisition_number)` ordenado por `paid_value DESC`), `paid` (janela de
pagamento, dedupe por requisição). Derivados no service reaproveitando `toMoney`, `percent`,
`average`, `resolvePeriod` de `analytics.service.ts`: `conversionQty = min(100, paid/budgets)`,
`ticket = paid_value/paid_count`, delta vs período anterior de mesma duração, série mensal,
`byAttendant`, `byInsurance`. Busca Ativa: `req` com `MAX(paid_value) = 0`,
`days_open = CURRENT_DATE - issued_on`, faixas 0-7/8-15/16-30/30+.

**PDFs** (Executivo e Busca Ativa) gerados **no cliente** com `jspdf` + `jspdf-autotable`
(lazy import) a partir de um JSON único do servidor (`GET /reports/executive`). Marca via
`theme.brandName` + `theme.logoUrl` — nada de "Santé" hardcoded. **D-116.**

### 2.2 Conciliação LIS ↔ propostas

- `PATCH /proposals/:id/lis-reference { lisBudgetNumber: string | null }` — attendant dona ou
  manager+; `CONFLICT` se outra proposta já usa; `PROPOSAL_ALREADY_CLOSED` só se `ganho`.
- No import, hook após cada chunk: `JOIN proposals ON number = lis_budget_number WHERE import_id`
  → requisição encontrada e proposta não terminal → `ProposalService.markWonFromLis` (extraído de
  `updateStatus`, reaproveita `insertHistory`, `insertSystemMessage`, `invalidateAnalytics`,
  audit com `newValues.source: 'lis_import'`, WS `proposal.status_changed`). `perdido` **não
  reabre** (conflito auditado). Pagamento só grava `lis_paid_*`. Idempotente. **D-119.**
- `FunnelReport` ganha `realized: { wonFromLis, paidCount, paidValue }` (janela de pagamento).
- Purge bloqueado se houver `lis_budgets.proposal_id` no tenant.

### 2.3 Rotas novas

Todas `requireAuth` + `denyPlatformOperator`:

| Rota | Papel mínimo |
|---|---|
| `/lis-imports` (`GET /`, `GET /latest`, `POST /`, `POST /purge`) | manager+; purge só admin |
| `/lis-budgets` (`GET /`, `/summary`, `/pending`, `/pending/summary`, `/filters`) | manager+ |
| `/sales` (`GET`, `POST`, `DELETE /:id`, `/summary`) | attendant restrito ao próprio `attendants.user_id` |
| `/attendants` (`GET`, `POST`, `PATCH /:id` — sem DELETE, D-004) | manager+ |
| `/settings/commissions` (`GET`, `PATCH`) | `GET` manager+, `PATCH` admin |
| `/reports/executive` | manager+ |
| `PATCH /proposals/:id/lis-reference` | attendant dona ou manager+ |

Telas novas: `/results`, `/reconciliation`, `/active-search`, `/sales`, `/settings/attendants`,
`/settings/commissions`. Todas na Sidebar única, filtradas só por papel.

---

## 3. Ondas

Cada onda: Agent-Docs escreve o contrato (Regra Zero) → agentes por pasta (`docs/AGENTS.md`) →
validadores Contratos / Segurança / Verificação → `STATUS.md`. Decisões D-108…D-121.

### Onda 9 — Domínio LIS no backend (~9 agent-days; API dividida em LisImport ∥ LisAnalytics ∥ Sales)

- **Docs:** `SCHEMA.md` (§24–27 + `tenant_settings` + `insurances` + `proposals` + cobertura RLS),
  `API_CONTRACTS.md` §10 LIS Budgets & Imports, §11 Sales, §12 Attendants, §6b Commission
  Settings, §5c Reports; `SERVICES.md`; `BUSINESS_RULES.md` §11 "Regras de deduplicação LIS";
  D-108…D-115 + D-118.
- **Migrações** `012_lis_domain.sql` + `013_rls_lis_domain.sql` (GRANT a `crm_app` + policies
  `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`, formato de
  `006_rls_onda7.sql`). Validar `GENERATED … STORED` no PGlite **na primeira hora**; fallback:
  calcular no repositório.
- **Rotas** conforme §2.3, exceto `lis-reference` (Onda 13).
- **Testes** em `backend/tests/lis/`: parser (aliases, PDF disfarçado, serial de data, vírgula
  decimal, linha sem número rejeitada); import idempotente; analytics (requisição duplicada em 2
  números; cap 100%; emissão vs pagamento); sales (escopo do atendente, comissão); attendants;
  `rls-onda9.spec`; rotas novas em `LAB_ROUTES` (**72 → ~90**).
- **DoD:** planilha real anonimizada do Santé importa e `GET /lis-budgets/summary` bate com o
  Dashboard antigo no mesmo período; tenant B não vê nada.

### Onda 10 — Telas do LIS (~10 agent-days; UI dividida em Results ∥ Sales ∥ LisReports)

- **Docs:** `PAGES.md` §14–19 (`/results`, `/reconciliation`, `/active-search`, `/sales`,
  `/settings/attendants`, `/settings/commissions`, modal Importar, "Limpar base" com confirmação
  digitando LIMPAR), `COMPONENTS.md` (`KpiCard`, `UploadDropzone`, `PeriodFilter`, `AgeBadge`).
  D-116, D-117.
- **Frontend:** `api/lis.ts`, `sales.ts`, `attendants.ts`, `reports.ts`; `query-keys.ts`;
  páginas; `jspdf` + `jspdf-autotable`; branding por tema; `document.title` por tela; zero hex.
  Filtros globais em `ui.store.ts` + sessionStorage (**D-117**).
- **Testes:** component tests; `route-config.spec` (Sidebar completa; atendente vê `/sales`);
  E2E `flow-17-lis-import-results` (fixture xlsx em `e2e/fixtures/`) e `flow-18-sales`.
- **DoD:** um gestor reproduz a rotina completa do Santé de ponta a ponta.

### Onda 11 — Infra Hostinger + migração do Santé (~5,5 agent-days)

- **Docs:** `docs/guides/DEPLOYMENT.md` (provisionamento do VPS, Caddy, `TRUST_PROXY_HOPS=2`,
  profiles do compose, backup off-site), novo `docs/guides/MIGRACAO_SANTE.md`. D-120, D-121.
- **Script** `backend/src/db/cli/migrate-sante.ts` (`npm run migrate:sante -- --input <dir>
  --slug sante`): lê CSVs do Supabase (`auth.users` com `encrypted_password`, `profiles`,
  `user_roles`, `atendentes`, `exames`, `importacoes`, `orcamentos`, `vendas`); cria o tenant via
  `createPlatformService().createTenant()` com o admin atual; insere o resto em
  `db.withTenant(tenantId)`; recusa slug existente. Papéis admin→admin, user→manager,
  atendente→attendant; `discount_limit_percent = DEFAULT_DISCOUNT_LIMIT[role]`; `attendants` =
  `atendentes` ∪ distinct(`orcamentos.usuario`) ∪ distinct(`vendas.atendente`), `user_id` via
  `profiles.atendente`; datas `::date`; convênios (D-114); exames (D-115). Tema verde do Santé.
  **D-120.**
- **Infra:** ver §5. `Caddyfile` + serviço `caddy` (remove `ports:` do frontend); `CORS_ORIGIN`;
  `pg_dump -Fc` antes de cada deploy + cron diário **com cópia off-site**; teste de restore antes
  do cutover.
- **Teste** `backend/tests/migration/migrate-sante.spec.ts` com CSVs sintéticos: contagens,
  login com a senha original, papéis, RLS, idempotência.
- **Checklist de paridade** (3 janelas: mês anterior, mês corrente, tudo): contagens de
  users/attendants/imports/budgets/sales/exams; KPIs de Resultados (orçado, requisição, recebido,
  conversão, ticket, atendentes, top-5, top-6 convênios, concentração top-2, série mensal 12
  meses); Busca Ativa (pendentes, valor, ticket, taxa, top-10, >30 dias); Vendas (total, por
  atendente, comissão 2/1,5/1,5); Conferência (totais). Tolerância zero em contagens, centavos
  em somas; divergência de fronteira de mês (D-110) listada explicitamente.

### Onda 12 — Cutover do Santé (~2 agent-days + 1–2 semanas de paralelo)

Runbook `docs/guides/CUTOVER_SANTE.md`: tag `fluxolab-final` no repo antigo + README
"congelado"; export final do Supabase; `migrate:sante` em prod; paridade assinada pelo Santé;
semanas paralelas (mesma planilha nos dois sistemas, comparação semanal); antigo em somente
leitura (policies de escrita → `false` + banner apontando o novo endereço); DNS antigo →
redirect 301; credenciais iguais; Supabase pausado após 30 dias, excluído após 90.

### Onda 13 — Conciliação LIS ↔ propostas (~5 agent-days)

- **Docs:** `API_CONTRACTS.md` §3 (`lisBudgetNumber` etc., `PATCH /proposals/:id/lis-reference`,
  `ImportLisResponse.proposalsWon`), §5 (`FunnelReport.realized`), `BUSINESS_RULES.md` §3
  (transição `* não-terminal → ganho` por origem LIS), `SCHEMA.md`. D-119.
- **Migração:** nenhuma — as colunas já vieram na `012` (D-118).
- **Backend:** `transitionInTx` / `markWonFromLis` em `ProposalService`; hook no
  `LisImportService`; `realized` em `analytics.repository.ts`; purge bloqueado com vínculo.
- **Frontend:** campo "Nº do orçamento no LIS" em `ProposalModal.tsx` e `Budget/New.tsx`; badge
  "Conciliado"; cartão "Receita realizada (LIS)" em `Analytics.tsx`.
- **Testes:** PATCH (conflito, closed); import → ganho com histórico/audit/WS; `perdido` não
  reabre; pagamento sem requisição não muda status; idempotência; isolamento entre tenants.
- **Roteiro de ativação no Santé:** ligar `attendants.user_id` → conectar WhatsApp por QR →
  treinar o nº do LIS na proposta → próxima importação já concilia.

---

## 4. Esforço e fluxo de trabalho

| Onda | Agent-days | Onde roda | Paralelismo |
|---|---|---|---|
| 9 | ~9 | **local** | DB primeiro; 3 agentes de API |
| 10 | ~10 | **local** | 3 agentes de UI ∥ QA; começa com mocks contra o contrato da 9 |
| 11 | ~5,5 | local + VPS | Infra ∥ script ∥ QA |
| 12 | ~2 | VPS | + calendário do paralelo |
| 13 | ~5 | **local** → deploy | API ∥ UI |
| **Total** | **~31,5** | | Santé fora da Vercel após a onda 12 |

**Fluxo:** ondas 9, 10 e 13 são construídas e validadas inteiramente na máquina local. O
`docker-compose.yml` de desenvolvimento já sobe `postgres`, `redis` e `evolution`, então o CRM
completo — WhatsApp incluído — roda local. Os ~1.700 testes usam PGlite e não precisam de
container algum. Commit → `main` no GitHub (`brodbeck-michel/crm-lab`) → CI
(`.github/workflows/ci.yml`) → deploy no VPS.

---

## 5. Infraestrutura de produção

**Alvo:** VPS Hostinger **KVM 2** (2 vCPU / 8GB RAM / 100GB NVMe), **região São Paulo**, Ubuntu
LTS + Docker, rodando `docker-compose.prod.yml` com Caddy na borda para TLS.

Orçamento de memória em regime (1 tenant, 1 instância de WhatsApp):

| Serviço | RAM típica |
|---|---|
| Evolution API (Baileys) | 400MB – 1GB |
| Postgres 16 | 250 – 400MB |
| Backend Node | 150 – 300MB |
| Redis | ~50MB |
| nginx + Caddy | ~50MB |
| SO + Docker | 400 – 600MB |
| **Total** | **~1,5 – 2,5GB de 8GB** |

Sobra headroom para pico do Evolution e cache do Postgres. CPU sobra: o único spike é o parse do
xlsx (500KB → segundos). Adicionar **2GB de swap** como seguro barato.

**Pontos de atenção operacional:**

- **Backup off-site é obrigatório.** `pg_dump -Fc` diário que fica no mesmo disco morre junto com
  o VPS. Enviar para bucket externo (R2/B2). Snapshot do painel da Hostinger com Postgres rodando
  **não é backup consistente** — serve para rollback de SO, não para recuperar banco.
- **Volume do Evolution é sagrado.** Rebuild do container sem preservar o volume perde a sessão do
  WhatsApp e exige re-escanear o QR — interrupção visível para o cliente.
- **Firewall: só 80/443 e SSH.** `postgres` e `evolution` já estão sem `ports:` no compose. Atenção:
  o Docker escreve iptables direto e **contorna regra de ufw** ao publicar porta — só o Caddy deve
  publicar.
- **`TRUST_PROXY_HOPS=2`** (Caddy → nginx → backend). O default atual é `1`, correto para o cenário
  sem Caddy. Errar isso colapsa rate limit e lockout no IP do proxy (D-057).
- **Escala futura:** o Evolution consome RAM **por instância de WhatsApp**. 8GB comportam ~5–10
  instâncias; além disso, mover o Evolution para box próprio. O vetor de crescimento de disco é o
  volume `media-data` (anexos do WhatsApp), não o banco.

---

## 6. Riscos

- Tabela nova sem policy **vaza**: par 012/013 e `rls-onda9.spec` são bloqueantes.
- `GENERATED STORED` no PGlite: validar na primeira hora da Onda 9; fallback no repositório.
- Fronteira de mês ao converter timestamp local → DATE: listar no relatório de paridade.
- Nomes de atendente com acento/caixa diferentes: dobra por `lower` + espaços; avaliar remoção
  de acentos como em `exam.repository.folded()`.
- `lis_budgets.patient_name` é dado pessoal sem `patient_id`: fora do fluxo D-063. Registrar em
  `SECURITY.md`; política de retenção em aberto.
- `exam_catalog` com preço 0 num tenant que passa a usar orçamentos do CRM: `Budget/New` precisa
  bloquear item sem preço (`EXAM_WITHOUT_PRICE`).
- `exceljs` não lê `.xls`: se o LIS mudar o formato, trocar para SheetJS oficial.
- Comissão passa de por-navegador para por-tenant: confirmar 2 / 1,5 / 1,5 com o Santé.
- **Ponto único de falha:** um VPS só. Aceito conscientemente nesta fase; a mitigação é o backup
  off-site testado, não redundância.
- Import síncrono: teto de bytes explícito mantido como defesa, embora 500KB não seja restrição.

## 7. Decisões em aberto (produto)

1. **Domínio de produção** — vira **bloqueante na Onda 11**: o Caddy emite TLS via Let's Encrypt
   por HTTP-01 e precisa do domínio já apontando para o IP.
2. `/catalog`: só nome/código/categoria/sinônimos ou também preços para exames `source='lis'`.
3. Convênios auto-criados `outro`: aparecem direto (recomendado) ou exigem classificação.
4. Retenção/anonimização de `patient_name` nos orçamentos do LIS.
5. Quando ligar o WhatsApp do Santé: recomendado só após cutover estável e Onda 13 validada.
6. Precificação do produto — adiada junto com os planos (D-108).

## 8. Dependências externas (destravar já)

| O quê | Trava | De quem |
|---|---|---|
| Planilha real do Santé, anonimizada (`.xlsx`) | DoD da Onda 9 | Santé |
| Export CSV do Supabase do FluxoLab | Onda 11 | acesso ao projeto `nxgpdaoeaafkfwzpyxap` |
| Domínio + DNS apontando para o VPS | Onda 11 (TLS) | lead |
| VPS Hostinger provisionada | Onda 11 | lead |

## 9. Verificação ponta a ponta

1. `npm run typecheck && npm test` verdes em cada onda; `npm run e2e` com os fluxos 17/18.
2. Onda 9: planilha real do Santé (anonimizada) num tenant de dev; cada KPI comparado com o
   FluxoLab rodando localmente no mesmo período; tenant B não enxerga nada.
3. Onda 10: rotina completa do Santé reproduzida na UI local, incluindo geração dos dois PDFs.
4. Onda 11: `migrate:sante` num Postgres limpo a partir do export real; checklist de paridade;
   login com credencial real; restore do `pg_dump` testado.
5. Onda 12: paralelo 1–2 semanas com comparação semanal assinada pelo Santé.
6. Onda 13: proposta com nº do LIS → planilha com requisição → `ganho` + histórico + audit + WS;
   reimportar → nada muda.
