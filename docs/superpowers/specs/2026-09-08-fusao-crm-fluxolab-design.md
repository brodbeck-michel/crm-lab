# Spec — Fusão CRM Lab + FluxoLab: um produto, planos Basic e Plus

**Data:** 2026-09-08
**Origem:** decisão do lead de unir o CRM (em validação, quase pronto) ao FluxoLab (painel de
orçamentos do Laboratório Santé, em produção na Vercel + Supabase `nxgpdaoeaafkfwzpyxap`),
hospedando tudo em domínio da Apexio.
**Status:** aprovada no desenho; ondas 9–14 ainda não iniciadas.
**Estado de partida:** CRM Lab em `1fa7f60` (v1.3.0, Onda 8 entregue). FluxoLab em `03f3e16`.

---

## 1. Contexto e objetivo

Dois produtos do mesmo domínio, em pontas opostas do mesmo processo. O **CRM Lab** produz o
orçamento (WhatsApp → proposta → pipeline). O **FluxoLab** lê o resultado (planilha do LIS →
requisição → valor pago → KPIs, Busca Ativa, comissão). O FluxoLab é, na prática, a "Trilha C"
(conciliação orçamento → requisição → baixa) que o CRM esperava da integração com o Bitlab,
feita por planilha em vez de API.

O objetivo é **um único produto**, com dois planos:

- **Basic** — tudo que o Santé usa hoje: importação de planilha do LIS, Resultados, Conferência,
  Busca Ativa, Vendas + comissão, Relatório executivo PDF, cadastro de atendentes/exames/usuários.
- **Plus** — Basic + todo o CRM (WhatsApp, atendimento, propostas, pipeline, convênios com preço,
  chat interno, etc.) + conciliação automática proposta ↔ LIS.

O upgrade Basic → Plus é uma troca de plano no console: sem migração de dados, sem mudar a rotina
de importação.

### O que existe hoje (verificado no código, não suposto)

| Ponto | CRM Lab | FluxoLab |
|---|---|---|
| Gating por plano | **Não existe.** `tenants.subscription_plan` (VARCHAR sem CHECK, default `starter`) só é lido por `PlatformService` para listar e faturar. Sem `PATCH /platform/tenants/:id`, sem tabela de assinatura, sem feature flag (`docs/ARCHITECTURE.md:212-215`). | Sem conceito de plano |
| Requisição / valor pago / importação de planilha / vendas | **Não existe.** `/analytics/*` lê só `proposals`. | É o núcleo: `orcamentos`, `importacoes`, `vendas` |
| Multitenancy | 3 camadas + RLS provada por teste (58 rotas em `LAB_ROUTES`) | **Zero.** 7 tabelas sem tenant, `numero` UNIQUE global, "Santé" hardcoded |
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

### Decisões do lead (2026-09-08) — não renegociar

1. **Reimplementar o FluxoLab dentro do CRM Lab** (Express + Postgres + RLS + `@crm-lab/shared` +
   testes). Não SSO entre dois apps, não manter Supabase. FluxoLab é congelado após o cutover.
2. **Planos `basic` e `plus`** substituem `starter/pro/enterprise`. Basic = mensalidade fixa.
   Plus = base + excedente de mensagens (modelo D-019). Valores em R$ continuam **a definir**.
3. **Basic inclui Vendas + comissão.** Atendente no Basic vê **só** `/sales` (paridade).
4. **Conciliação (Plus):** a atendente digita o **nº do orçamento do LIS** na proposta; a
   importação casa por `(tenant_id, número)`. Requisição encontrada → proposta vai para `ganho`
   automaticamente; pagamento só grava valor/data.
5. **Hospedagem:** VPS + `docker-compose.prod.yml` existente + Caddy na borda (TLS). Domínio único
   (`app.<dominio-apexio>`, a definir); tenant sempre pelo JWT, sem subdomínio.
6. **Cutover do Santé:** operação paralela 1–2 semanas com checklist de paridade → antigo em
   somente leitura → fora do ar. **Santé é o piloto do Plus.**
7. **Ordem:** migrar o Santé para o Basic **antes** de construir a conciliação.
8. **Planilha sempre `.xlsx`** → `exceljs` no backend (sem advisories; não lê `.xls`).
9. **Senhas migram como estão** (bcrypt nos dois lados).
10. **Upload de planilha em base64 no JSON**, como a Onda 8 (`media.service.ts:4-6`).

---

## 2. Arquitetura alvo

### 2.1 Plano e entitlement

- O plano viaja **no JWT** (`JwtPayload.plan`) e em `TenantContext.plan`. `requirePlan('plus')`
  ao lado de `requireRoles`. Token sem `plan` (deploy em andamento) = `basic`.
- `PATCH /platform/tenants/:id` altera `plan`, `isActive`, `subscriptionUntil`; mudança de plano
  **revoga os refresh tokens do tenant** (força re-login, fecha a janela de downgrade). Auditado.
- Novo `ApiErrorCode` **`PLAN_REQUIRED`** (403, `details: { requiredPlan, currentPlan }`).
- Frontend: `AppRoute.requiredPlan?`, `sidebarRoutesFor(role, plan)`, `homeFor(role, plan)`, guard
  `RequirePlan`. `PLAN_FEATURES` em `shared/types/platform.types.ts` é a fonte única da lista.
- Home no Basic: manager/admin → `/results`; attendant → `/sales`.

| Plano mínimo | Backend | Frontend |
|---|---|---|
| **basic** | `/auth`, `/users`, `/themes`, `/audit`, `/exams`, `/insurances`, `/platform`, **novos** `/lis-imports`, `/lis-budgets`, `/sales`, `/attendants`, `/settings/commissions`, `/reports/executive` | `/results`, `/reconciliation`, `/active-search`, `/sales`, `/settings/attendants`, `/settings/commissions`, `/settings/users`, `/settings/theme`, `/settings/insurances`, `/catalog` (sem preços) |
| **plus** | `/conversations`, `/webhooks` (tenant basic → 200 sem processar), `/patients`, `/proposals`, `/internal-chat`, `/quick-replies`, `/media`, `/settings/channels`, `/operations`, `/analytics` | `/attendance`, `/patients/:id`, `/budget/new`, `/proposals`, `/analytics`, `/internal-chat`, `/quick-replies`, `/decisions`, `/settings/channels`, `/settings/operation` |

### 2.2 Domínio "Orçamentos do LIS" (Basic e Plus)

Tabelas novas, todas com `tenant_id` + policy RLS no mesmo par de migrações:

- **`attendants`** — `name`, `folded_name` (gerada: `lower` + espaços colapsados), `is_active`,
  `user_id` opcional (`UNIQUE (tenant_id, user_id)`), `UNIQUE (tenant_id, folded_name)`.
  O `USUÁRIO` da planilha vira `attendant_id`; no upgrade só se liga `user_id`.
- **`lis_imports`** — histórico imutável: `kind import|purge`, `file_name`, `rows_in_file`,
  `rows_accepted`, `rows_rejected`, `proposals_won`, `status processing|completed|failed`,
  `error_message`, `created_by`, `finished_at`. Sem DELETE na API.
- **`lis_budgets`** — 1 linha por `UNIQUE (tenant_id, number)`: `issued_on DATE`,
  `patient_name`, `insurance_1..3` + `value_1..3`, colunas geradas STORED
  `principal_insurance_name` e `total_value` (regra do convênio principal), `insurance_id`
  resolvido (NULL = particular, D-082), `attendant_name` + `attendant_id`, `insurance_average`,
  `requisition_number`, `requisition_value`, `paid_value`, `paid_on DATE`, `import_id`,
  `proposal_id` nullable (Onda 14). Índices por `(tenant_id, issued_on)`, `(tenant_id, paid_on)
  WHERE paid_value > 0`, `(tenant_id, requisition_number)`, `(tenant_id, attendant_id)`.
- **`sales`** — `attendant_id`, `sold_on DATE`, `code`, `value > 0`, `exams` (texto),
  `kind exams|checkup`, `created_by`.
- **`tenant_settings`** ganha `commission_budget_pct` (2,00), `commission_exams_pct` (1,50),
  `commission_checkup_pct` (1,50).
- **`insurances`** ganha `type = 'outro'` no CHECK e `source manual|lis`.

Escolhas de modelagem:

- Datas do LIS são `DATE`, não `TIMESTAMP` (o serial do Excel não tem fuso; todo agrupamento é por
  dia/mês; elimina a classe de bug de UTC-3).
- Convênio da planilha é resolvido por nome dobrado em `insurances`; inexistente é **criado**
  com `type='outro'`, `source='lis'`. `PARTICULAR` e variantes → `insurance_id NULL`. O nome
  bruto fica em `insurance_1..3`.
- Exames do FluxoLab entram em `exam_catalog` com `price_private = 0`, `price_insurance = 0`,
  `source='lis'`; sinônimos em `exam_synonyms`. A UI do Catálogo marca "sem preço"; o Basic não
  usa preço.

**Import:** `POST /lis-imports { fileName, contentBase64 }` → parser puro em
`backend/src/lib/lis-spreadsheet.ts` (exceljs; guard `%PDF`; exige `ORCAMENTO`; mesmos aliases)
→ `consolidateByNumber` (port de `consolidateOrcamentos`) → resolve atendentes e convênios →
upsert `ON CONFLICT (tenant_id, number)` em chunks → status + `audit.record` + invalidação de
cache `lis:<tenant>:`. Erro de planilha → `VALIDATION_ERROR` com `details.reason`
(`pdf_disguised | missing_column | empty`). Purge (admin) apaga `lis_budgets` do tenant e registra
`lis_imports(kind='purge')`.

**KPIs em SQL** (`lis-analytics.repository.ts`): CTEs `issued` (janela de emissão),
`req` (`DISTINCT ON (requisition_number)` ordenado por `paid_value DESC`), `paid` (janela de
pagamento, dedupe por requisição). Derivados no service reaproveitando `toMoney`, `percent`,
`average`, `resolvePeriod` de `analytics.service.ts`: `conversionQty = min(100, paid/budgets)`,
`ticket = paid_value/paid_count`, delta vs período anterior de mesma duração, série mensal,
`byAttendant`, `byInsurance`. Busca Ativa: `req` com `MAX(paid_value) = 0`,
`days_open = CURRENT_DATE - issued_on`, faixas 0-7/8-15/16-30/30+.

**PDFs** (Executivo e Busca Ativa) gerados **no cliente** com `jspdf` + `jspdf-autotable`
(lazy import) a partir de um JSON único do servidor (`GET /reports/executive`). Marca via
`theme.brandName` + `theme.logoUrl` — nada de "Santé" hardcoded.

### 2.3 Conciliação LIS ↔ propostas (Plus)

- `proposals.lis_budget_number` (índice único parcial por tenant), `lis_requisition_number`,
  `lis_paid_value`, `lis_paid_on`, `lis_reconciled_at`.
- `PATCH /proposals/:id/lis-reference { lisBudgetNumber: string | null }` — attendant dona ou
  manager+; `CONFLICT` se outra proposta já usa; `PROPOSAL_ALREADY_CLOSED` só se `ganho`.
- No import, hook após cada chunk: `JOIN proposals ON number = lis_budget_number WHERE import_id`
  → requisição encontrada e proposta não terminal → `ProposalService.markWonFromLis` (extraído de
  `updateStatus`, reaproveita `insertHistory`, `insertSystemMessage`, `invalidateAnalytics`,
  audit com `newValues.source: 'lis_import'`, WS `proposal.status_changed`). `perdido` **não
  reabre** (conflito auditado). Pagamento só grava `lis_paid_*`. Idempotente.
- `FunnelReport` ganha `realized: { wonFromLis, paidCount, paidValue }` (janela de pagamento).
- Purge bloqueado se houver `lis_budgets.proposal_id` no tenant.

---

## 3. Ondas

Cada onda: Agent-Docs escreve o contrato (Regra Zero) → agentes por pasta (`docs/AGENTS.md`) →
validadores Contratos / Segurança / Verificação → `STATUS.md`. Decisões D-086…D-100.

### Onda 9 — Planos basic/plus + entitlement (~2–3 agent-days)

- **Docs:** `API_CONTRACTS.md` §5b (enum, `PATCH /platform/tenants/:id`, billing por modelo,
  "Entitlement por plano"), `API_ERRORS.md` (`PLAN_REQUIRED`), `SCHEMA.md` §1, `PAGES.md`
  (coluna Plano + redirect), `TESTING.md` (dimensão `plan` no inventário). D-086 (planos), D-087
  (plano no JWT + revogação), D-088 (drop `extra_messages`, nunca lida).
- **Migração `010_plans_basic_plus.sql`:** `UPDATE tenants SET subscription_plan='plus'` nos
  existentes; default `basic`; NOT NULL; CHECK `('basic','plus')`; `DROP COLUMN extra_messages`.
  Seeds: `lab-vida`=plus, `lab-central`=basic. Factories: default `plus`.
- **Shared:** `SubscriptionPlan`, `UpdateTenantRequest`, `PLAN_FEATURES`, `JwtPayload.plan`,
  `AuthTenant.plan`, `ApiErrorCode.PLAN_REQUIRED`.
- **Backend:** `tokens.ts`, `auth.service.ts` + `user.repository.ts#findLoginCandidatesByEmail`
  (JOIN traz `subscription_plan`; refresh relê), `context.ts`, `middleware/auth.ts#requirePlan`,
  `errors.ts`, `platform.service.ts` (`PLAN_CATALOG` com 2 planos, `billingFor` sem excedente no
  basic, `updateTenant` + `revokeRefreshTokensOfTenant`), `platform.routes.ts` (`PATCH`).
  `requirePlan('plus')` nos routers Plus. Webhooks de tenant basic → 200 sem processar.
- **Frontend:** `route-config.ts`, `guards.tsx`, `Sidebar.tsx`, `api/error-handler.ts`,
  `Platform/Tenants.tsx` (alterar plano/ativo), `Platform/Billing.tsx`.
- **Testes:** `requirePlan`; `PATCH` (operador OK, admin 403, 404, corpo vazio 400, audit);
  `route-tenant-isolation.spec` ganha a invariante "usuário basic recebe 403 `PLAN_REQUIRED` em
  toda rota plus"; front `route-config.spec`, `guards.spec`, `Tenants.spec`.
- **DoD:** login devolve `tenant.plan`; tenant basic não abre nada de `/conversations` (API e
  UI); `PATCH` auditado; billing sem `NaN`; docs no mesmo commit.

### Onda 10 — Domínio LIS no backend (~9 agent-days; API dividida em LisImport ∥ LisAnalytics ∥ Sales)

- **Docs:** `SCHEMA.md` (§24–27 + `tenant_settings` + `insurances` + cobertura RLS),
  `API_CONTRACTS.md` §10 LIS Budgets & Imports, §11 Sales, §12 Attendants, §6b Commission
  Settings, §5c Reports; `SERVICES.md`; `BUSINESS_RULES.md` §11 "Regras de deduplicação LIS";
  D-089 (import base64 + parser puro + exceljs), D-090 (DATE), D-091 (colunas geradas), D-092
  (attendants), D-093 (comissão em `tenant_settings`), D-094 (convênio auto-criado `outro`),
  D-095 (catálogo com preço 0).
- **Migrações** `011_lis_domain.sql` + `012_rls_lis_domain.sql` (GRANT a `crm_app` + policies
  `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`, formato de
  `006_rls_onda7.sql`). Validar `GENERATED … STORED` no PGlite; fallback: calcular no repositório.
- **Rotas** (todas `requireAuth`, `denyPlatformOperator`, plano basic): `/lis-imports` (`GET /`,
  `GET /latest`, `POST /`, `POST /purge` admin); `/lis-budgets` (`GET /`, `/summary`, `/pending`,
  `/pending/summary`, `/filters`) manager+; `/sales` (`GET`, `POST`, `DELETE /:id`, `/summary`;
  attendant restrito ao próprio `attendants.user_id`); `/attendants` (`GET`, `POST`, `PATCH /:id`;
  sem DELETE, D-004); `/settings/commissions` (`GET`, `PATCH` admin); `/reports/executive` manager+.
- **Testes** em `backend/tests/lis/`: parser (aliases, PDF disfarçado, serial de data, vírgula
  decimal, linha sem número rejeitada); import idempotente; analytics (requisição duplicada em 2
  números; cap 100%; emissão vs pagamento); sales (escopo do atendente, comissão); attendants;
  `rls-onda10.spec`; rotas novas em `LAB_ROUTES` (58 → ~76).
- **DoD:** planilha real anonimizada do Santé importa e `GET /lis-budgets/summary` bate com o
  Dashboard antigo no mesmo período; tenant B não vê nada.

### Onda 11 — Telas do Basic (~10 agent-days; UI dividida em Results ∥ Sales ∥ LisReports)

- **Docs:** `PAGES.md` §14–19 (`/results`, `/reconciliation`, `/active-search`, `/sales`,
  `/settings/attendants`, `/settings/commissions`, modal Importar, "Limpar base" com confirmação
  digitando LIMPAR), `COMPONENTS.md` (`KpiCard`, `UploadDropzone`, `PeriodFilter`, `AgeBadge`).
  D-096 (PDF no cliente), D-097 (filtros globais em `ui.store.ts` + sessionStorage).
- **Frontend:** `api/lis.ts`, `sales.ts`, `attendants.ts`, `reports.ts`; `query-keys.ts`;
  páginas; `jspdf` + `jspdf-autotable`; branding por tema; `document.title` por tela; zero hex.
- **Testes:** component tests; `route-config.spec` (Sidebar Basic; atendente Basic só Vendas);
  E2E `flow-17-basic-import-results` (fixture xlsx em `e2e/fixtures/`) e `flow-18-sales`.
- **DoD:** um gestor de tenant basic reproduz a rotina completa do Santé sem tocar no Plus.

### Onda 12 — Migração do Santé + infra de borda (~5,5 agent-days)

- **Docs:** `DEPLOYMENT.md` (Caddy, `TRUST_PROXY_HOPS=2`, profiles do compose, backup), novo
  `docs/guides/MIGRACAO_SANTE.md`. D-099 (script pelo caminho do onboarding), D-100 (Caddy).
- **Script** `backend/src/db/cli/migrate-sante.ts` (`npm run migrate:sante -- --input <dir>
  --slug sante`): lê CSVs do Supabase (`auth.users` com `encrypted_password`, `profiles`,
  `user_roles`, `atendentes`, `exames`, `importacoes`, `orcamentos`, `vendas`); cria o tenant via
  `createPlatformService().createTenant({ plan: 'basic' })` com o admin atual; insere o resto em
  `db.withTenant(tenantId)`; recusa slug existente. Papéis admin→admin, user→manager,
  atendente→attendant; `discount_limit_percent = DEFAULT_DISCOUNT_LIMIT[role]`; `attendants` =
  `atendentes` ∪ distinct(`orcamentos.usuario`) ∪ distinct(`vendas.atendente`), `user_id` via
  `profiles.atendente`; datas `::date`; convênios (D-094); exames (D-095). Tema verde do Santé.
- **Infra:** `Caddyfile` + serviço `caddy` (remove `ports:` do frontend); `CORS_ORIGIN`;
  `WHATSAPP_*`/`EVOLUTION_*` vazios; `pg_dump -Fc` antes de cada deploy + cron diário; teste de
  restore antes do cutover.
- **Teste** `backend/tests/migration/migrate-sante.spec.ts` com CSVs sintéticos: contagens,
  login com a senha original, papéis, RLS, idempotência.
- **Checklist de paridade** (3 janelas: mês anterior, mês corrente, tudo): contagens de
  users/attendants/imports/budgets/sales/exams; KPIs de Resultados (orçado, requisição, recebido,
  conversão, ticket, atendentes, top-5, top-6 convênios, concentração top-2, série mensal 12
  meses); Busca Ativa (pendentes, valor, ticket, taxa, top-10, >30 dias); Vendas (total, por
  atendente, comissão 2/1,5/1,5); Conferência (totais). Tolerância zero em contagens, centavos
  em somas; divergência de fronteira de mês (D-090) listada explicitamente.

### Onda 13 — Cutover do Santé (~2 agent-days + 1–2 semanas de paralelo)

Runbook `docs/guides/CUTOVER_SANTE.md`: tag `fluxolab-final` no repo antigo + README
"congelado"; export final do Supabase; `migrate:sante` em prod; paridade assinada pelo Santé;
semanas paralelas (mesma planilha nos dois sistemas, comparação semanal); antigo em somente
leitura (policies de escrita → `false` + banner apontando o novo endereço); DNS antigo →
redirect 301; credenciais iguais; Supabase pausado após 30 dias, excluído após 90.

### Onda 14 — Conciliação LIS ↔ propostas (Plus, ~5 agent-days) → piloto Plus do Santé

- **Docs:** `API_CONTRACTS.md` §3 (`lisBudgetNumber` etc., `PATCH /proposals/:id/lis-reference`,
  `ImportLisResponse.proposalsWon`), §5 (`FunnelReport.realized`), `BUSINESS_RULES.md` §3
  (transição `* não-terminal → ganho` por origem LIS), `SCHEMA.md`. D-098.
- **Migração** `013_proposals_lis_reference.sql` (5 colunas + índice único parcial).
- **Backend:** `transitionInTx` / `markWonFromLis` em `ProposalService`; hook no
  `LisImportService`; `realized` em `analytics.repository.ts`; purge bloqueado com vínculo.
- **Frontend:** campo "Nº do orçamento no LIS" em `ProposalModal.tsx` e `Budget/New.tsx`; badge
  "Conciliado"; cartão "Receita realizada (LIS)" em `Analytics.tsx`.
- **Testes:** PATCH (conflito, closed); import → ganho com histórico/audit/WS; `perdido` não
  reabre; pagamento sem requisição não muda status; idempotência; isolamento entre tenants.
- **Roteiro de upgrade do Santé:** `PATCH /platform/tenants/:id { plan: 'plus' }` → re-login →
  ligar `attendants.user_id` → conectar WhatsApp por QR → treinar o nº do LIS na proposta →
  próxima importação já concilia.

---

## 4. Esforço

| Onda | Agent-days | Paralelismo |
|---|---|---|
| 9 | 2–3 | Docs → DB ∥ Kernel/API ∥ UI |
| 10 | ~9 | DB primeiro; 3 agentes de API; UI da 11 começa com mocks contra o contrato |
| 11 | ~10 | 3 agentes de UI ∥ QA |
| 12 | ~5,5 | Infra ∥ script ∥ QA |
| 13 | ~2 | + calendário do paralelo |
| 14 | ~5 | API ∥ UI |
| **Total** | **~34** | Santé fora da Vercel após 9–13 |

---

## 5. Riscos

- Tabela nova sem policy **vaza**: par 011/012 e `rls-onda10.spec` são bloqueantes.
- `GENERATED STORED` no PGlite: validar cedo; fallback no repositório.
- Plano no JWT: até 15 min após downgrade (mitigado pela revogação de refresh tokens).
- `TRUST_PROXY_HOPS` errado com Caddy + nginx colapsa rate limit e lockout no IP do proxy (D-057).
- Fronteira de mês ao converter timestamp local → DATE: listar no relatório de paridade.
- Nomes de atendente com acento/caixa diferentes: dobra por `lower` + espaços; avaliar remoção
  de acentos como em `exam.repository.folded()`.
- `lis_budgets.patient_name` é dado pessoal sem `patient_id`: fora do fluxo D-063. Registrar em
  `SECURITY.md`; política de retenção em aberto.
- Import síncrono com planilha grande: teto de bytes explícito; `proxy_read_timeout` na rota.
- `exam_catalog` com preço 0 num tenant que sobe para Plus: `Budget/New` precisa bloquear item
  sem preço (`EXAM_WITHOUT_PRICE`).
- `exceljs` não lê `.xls`: se o LIS mudar o formato, trocar para SheetJS oficial.
- Comissão passa de por-navegador para por-tenant: confirmar 2 / 1,5 / 1,5 com o Santé.

## 6. Decisões em aberto (produto)

1. Valores de `basic` e `plus` e excedente por mensagem (D-019 continua provisória).
2. Domínio de produção.
3. `/catalog` no Basic: só nome/código/categoria/sinônimos (recomendado) ou também preços.
4. Convênios auto-criados `outro`: aparecem direto (recomendado) ou exigem classificação.
5. Retenção/anonimização de `patient_name` nos orçamentos do LIS.
6. Quando ligar o WhatsApp do Santé: recomendado só após cutover estável e Onda 14 validada.

## 7. Verificação ponta a ponta

1. `npm run typecheck && npm test` verdes em cada onda; `npm run e2e` com os fluxos 17/18.
2. Onda 9: tenant basic → Sidebar sem itens Plus; `/api/v1/conversations` com token basic → 403
   `PLAN_REQUIRED`; `PATCH` → re-login → Sidebar completa.
3. Ondas 10/11: planilha real do Santé (anonimizada) no tenant de dev; cada KPI comparado com o
   FluxoLab rodando localmente no mesmo período.
4. Onda 12: `migrate:sante` num Postgres limpo a partir do export real; checklist de paridade;
   login com credencial real.
5. Onda 13: paralelo 1–2 semanas com comparação semanal assinada pelo Santé.
6. Onda 14: proposta com nº do LIS → planilha com requisição → `ganho` + histórico + audit + WS;
   reimportar → nada muda.
