# 📊 STATUS do Projeto

Arquivo de coordenação vivo. Todo agente atualiza aqui ao reivindicar, avançar ou concluir tarefas.

**Última atualização:** 2026-08-24 (fim da Onda 5)

---

## Legenda

- ⬜ Não iniciado
- 🔄 Em andamento (com nome do agente)
- ✅ Concluído (com data)
- ⛔ Bloqueado (com motivo)

---

## Onda 1 — Fundação

| Tarefa | Domínio | Status | Agente | Notas |
|--------|---------|--------|--------|-------|
| docker-compose (Postgres + Redis) | infra | ⬜ | — | |
| Estrutura de pastas frontend/backend | infra | ⬜ | — | |
| Kernel do backend (config, db, http, lib, helpers de teste) | api | ✅ 2026-08-23 | Agent-Kernel | `src/config` `src/db` `src/http` `src/lib` `src/app.ts` `src/main.ts` `tests/helpers` `tests/kernel`. 62 testes verdes. Ponto de extensao de rotas: `src/http/modules.ts` |
| Migração 001: schema inicial | db | ✅ 2026-08-23 | Agent-DB | `001_initial_schema.sql` + `002_row_level_security.sql`. 13 tabelas, correções do D-012, RLS real nas 13 (inclusive `tenants`, por `id`) verificada em PGlite com 2 tenants |
| Design tokens CSS (temas + rampas) | ui | ✅ 2026-08-23 | Agent-UI-Foundation | `frontend/src/styles/tokens.css` + `tailwind.config.js` (tema mapeado para CSS vars) + `src/lib/theme.ts` (`applyTheme`, `THEME_PRESETS`) |
| Componentes base (Button, Chip, Input, Card, Badge) | ui | ✅ 2026-08-23 | Agent-UI-Foundation | `ui/`: Button, Chip, Badge, Input, TextArea, SearchInput, SegmentedControl, Select, Toggle, Tooltip, Toast · `shared/`: Avatar, EmptyState, Modal, DataTable, MoneyDisplay, DateDisplay · `lib/format.ts` · 193 testes verdes |

## Onda 2 — Auth e Layouts

| Tarefa | Domínio | Status | Agente | Notas |
|--------|---------|--------|--------|-------|
| AuthService + JWT multitenant | api | ✅ 2026-08-23 | Agent-API-Auth | `services/auth.service.ts` + `controllers/auth.routes.ts` + repos `user`/`tenant`/`refresh-token`. Login (tema embutido), refresh com rotação + detecção de reuso (D-015), logout, `validateToken`. 14 testes em `tests/auth/` |
| UserService + endpoints `/users` | api | ✅ 2026-08-23 | Agent-API-Auth | `services/user.service.ts` + `controllers/user.routes.ts`. `GET /users/me`, `GET/POST /users`, `PATCH /users/:id` (admin). D-013: sem auto-elevação. Isolamento 2 tenants coberto (PATCH cross-tenant = 404). 17 testes em `tests/users/` |
| Middleware tenant isolation | api | ✅ 2026-08-23 | Agent-Kernel | `db.withTenant()` (SET LOCAL ROLE crm_app + set_config('app.tenant_id', $1, true)) + `requireAuth`/`requireRoles`. Isolamento provado com 2 tenants em `tests/kernel/tenant-isolation.spec.ts` |
| Seeds de desenvolvimento | db | ✅ 2026-08-23 | Agent-DB-Seeds | `src/db/seeds/` (`index.ts` · `dev.ts` · `e2e.ts` · `e2e-fixtures.ts` · `catalog.ts` · `writers.ts` · `themes.ts` · `ids.ts`). **3 tenants** (`lab-vida` Terracota, `lab-central` Azul Jaleco, `plataforma`), 8 usuários (senha `senha123`, credenciais impressas no fim), 106 exames, 114 conversas, 481 mensagens, 44 propostas nos 6 estágios (1 `pending` com 25%), histórico legal, audit logs. `npm run seed:e2e` = dataset fixo. Idempotente (truncate+recria), recusa rodar em `NODE_ENV=production`. 26 testes em `tests/seeds/` |
| Layout Sidebar (244/72px) | ui | ✅ 2026-08-23 | Agent-UI-Shell | `components/layout/Sidebar.tsx` — itens de `routes/route-config.ts`; recolhe sozinha para atendente em `/attendance` |
| Shell do Inbox (3 colunas) | ui | ✅ 2026-08-23 | Agent-UI-Shell | `InboxLayout` (336 \| flex min 440 \| 316) + `BudgetLayout` (flex min 520 \| 372) + `AppShell`/`PlatformShell`/`PageHeader`/`PageContainer` |
| Bootstrap (`main.tsx` + `App.tsx`) | ui | ✅ 2026-08-23 | Agent-UI-Shell | Importa `@/styles/tokens.css`; `QueryClientProvider` → `ToastProvider` → `RouterProvider` |
| Camada de API + interceptor de refresh | ui | ✅ 2026-08-23 | Agent-UI-Shell | `src/api/` — 10 módulos de recurso + `client`/`error-handler`/`query-keys`/`ws`. Refresh único compartilhado, testado com 5 requisições concorrentes |
| Estado global (Zustand) | ui | ✅ 2026-08-23 | Agent-UI-Shell | `useAuthStore` (sessão, persistida) + `useUIStore`. Fronteira "dado de servidor nunca no Zustand" é teste, não convenção |
| Roteamento + guards | ui | ✅ 2026-08-23 | Agent-UI-Shell | Todas as rotas de PAGES.md com `requiredRoles`; sem permissão → redirect + toast; `/` redireciona por perfil |

## Onda 3 — Conversas e Catálogo

| Tarefa | Domínio | Status | Agente | Notas |
|--------|---------|--------|--------|-------|
| ConversationService + endpoints | api | ✅ 2026-08-23 | Agent-API-Conversations | `services/conversation.service.ts` + `controllers/conversation.routes.ts` + `repositories/conversation.repository.ts`. `GET /conversations` (com `counts` derivados do mesmo SELECT), `GET /conversations/:id` (marca como lida — D-027), `PATCH /conversations/:id`, `POST /conversations/:id/read`. Corrida de atribuição resolvida na escrita (D-023), transferência com mensagem de sistema. 29 testes em `tests/conversations/` |
| MessageService + WebSocket | api | ✅ 2026-08-23 | Agent-API-Conversations | `services/message.service.ts` + `services/whatsapp.service.ts` + `lib/queue.ts` + `controllers/webhook.routes.ts`. `POST /conversations/:id/messages`, webhooks públicos com HMAC em tempo constante, retry exponencial 3×, driver mock em dev/teste. **`createSystemEvent` pronto para o ProposalService** — ver pedido abaixo. 35 testes em `tests/messages/` e `tests/whatsapp/` |
| ExamCatalogService + endpoints | api | ✅ 2026-08-23 | Agent-API-Catalog | `GET/POST/PATCH /exams` + cache 1h por tenant. 42 testes em `backend/tests/catalog/`. `getByIds`/`resolveActiveByIds` prontos para o ProposalService (SERVICES.md §5) |
| Tela Login | ui | ✅ 2026-08-23 | Agent-UI-Attendance | `src/pages/Login.tsx` + `Login.spec.tsx` (9 testes). Tema aplicado do payload do login (sem request extra); erro genérico único para credencial errada / e-mail inexistente / conta inativa |
| Tela Atendimento (inbox funcional) | ui | ✅ 2026-08-23 | Agent-UI-Attendance | `src/pages/Attendance/` + `components/conversation/` (`ConversationItem`, `MessageBubble`, `Composer`). 3 colunas, chips com contagem do servidor, markAsRead ao abrir, estados de carregando/vazio/erro. **Sem mocks**: consome `GET /conversations` real — a tela fica no estado de erro enquanto o ConversationService não existir |

## Onda 4 — Propostas ✅ (concluída em 2026-08-24)

| Tarefa | Domínio | Status | Agente | Notas |
|--------|---------|--------|--------|-------|
| ProposalService (alçada + cálculo) | api | ✅ 2026-08-23 | Agent-API-Proposals | `services/proposal.service.ts` + `repositories/proposal.repository.ts` + `controllers/proposal.routes.ts`. `GET/POST /proposals`, `GET /proposals/:id`, `PATCH /:id/status|discount|approve|reject`. Total sempre derivado (`calculateTotal` de shared), snapshot D-004, alçada lida do banco, matriz de `ALLOWED_TRANSITIONS`, histórico + WS + auditoria. 64 testes em `tests/proposals/` |
| ApprovalService | api | ✅ 2026-08-23 | Agent-API-Proposals | `services/approval.service.ts` (+ `internal-chat.service.ts` e `controllers/internal-chat.routes.ts`, SERVICES.md §7). Pedido postado em `#aprovacoes` com proposta anexada + WS `approval.requested`; aprova só manager/admin dentro da própria alçada; sem auto-aprovação (D-046). 23 testes em `tests/approvals/` e `tests/internal-chat/` |
| **Plano: 7 Telas UI + Validador** | ui+qa | 🔄 planejado | — | Plano em `docs/superpowers/plans/2026-08-24-onda-4-ui-screens.md`. 7 agentes paralelos (Novo Orçamento, Pipeline, Modal Proposta, Catálogo, Conversão, Personalização, Usuários) + E2E. Execução: `superpowers:subagent-driven-development` ou `superpowers:dispatching-parallel-agents` |
| Tela Novo Orçamento (Budget/new) | ui | ✅ 2026-08-24 | Agent-UI-Budget | Task 1 do plano: catálogo segmentado, desconto com validação, resumo com total derivado |
| Tela Pipeline (Proposals) + Modal | ui | ✅ 2026-08-24 | Agent-UI-Proposals + Agent-UI-ProposalModal | Tasks 2-3: 6 colunas kanban, cartões clicáveis, modal com histórico, aprovação, win/loss |
| Tela Catálogo (Catalog) | ui | ✅ 2026-08-24 | Agent-UI-Catalog | Task 4: tabela de exames, atendente lê, gestor cria/edita |
| Tela Conversão (Analytics) | ui | ✅ 2026-08-24 | Agent-UI-Analytics | Task 5: dashboard com funil, receita, motivos de perda, top performers |
| Tela Personalização (Settings/theme) | ui | ✅ 2026-08-24 | Agent-UI-Theme | Task 6: selector de 5 presets + custom color picker |
| Tela Usuários (Settings/users) | ui | ✅ 2026-08-24 | Agent-UI-Users | Task 7: CRUD de usuários, papéis, alçada, ativo/inativo |
| E2E fluxos 1-3 | qa | ✅ 2026-08-24 | Agent-QA-E2E | Task 9: `e2e/workflows/` com `playwright.config.ts`, `helpers.ts`, `flow-1-new-budget.spec.ts`, `flow-2-approval.spec.ts`, `flow-3-win-loss.spec.ts`. 3 specs testando fluxos críticos: orçamento novo, aprovação de desconto alto, ganho/perda. Importa constantes de `backend/src/db/seeds/e2e-fixtures.ts`. Typecheck ✅ |

## Onda 5 — Analytics, Tema e Plataforma ✅ (concluída em 2026-08-24)

| Tarefa | Domínio | Status | Agente | Notas |
|--------|---------|--------|--------|-------|
| AnalyticsService | api | ✅ 2026-08-23 | Agent-API-Analytics | `services/analytics.service.ts` + `repositories/analytics.repository.ts` + `controllers/analytics.routes.ts`. `GET /analytics/conversion\|pipeline\|team`. Todos os números derivam de `proposals` (BUSINESS_RULES §5); cache 5 min por **(tenant, escopo do usuário, relatório, período)**. Atendente recebe `partial: true` e só as próprias métricas. 41 testes em `tests/analytics/` |
| PlatformService (console isolado) | api | ✅ 2026-08-23 | Agent-API-Analytics | `services/platform.service.ts` + `repositories/platform.repository.ts` + `controllers/platform.routes.ts`. `GET\|POST /platform/tenants`, `GET /platform/billing`. Só `platform_operator`; `withoutTenant` como exceção auditada; onboarding atômico (tenant + tema Terracota + `#geral`/`#aprovacoes` + admin). 29 testes em `tests/platform/` |
| ThemeService | api | ✅ 2026-08-23 | Agent-API-Auth | `services/theme.service.ts` + `controllers/theme.routes.ts`. `GET/PATCH /themes/current`, `GET /themes/presets` (5 presets estáticos). Só cores base (D-005); hex validado. 11 testes em `tests/theme/` |
| AuditService | api | ✅ 2026-08-23 | Agent-API-Auth | `services/audit.service.ts` (append-only, `log()` nunca lança, `failures` inspecionável) + `GET /audit` admin. **Infraestrutura compartilhada** — ver pedido abaixo. 9 testes em `tests/users/audit.spec.ts` |
| Tela Conversão | ui | ✅ 2026-08-24 | Agent-UI-Analytics | `pages/Analytics.tsx`. Aviso de **versão parcial** (`partial: true`) para atendente entregue na rodada de correção |
| Tela Personalização | ui | ✅ 2026-08-24 | Agent-UI-Theme | `pages/Settings/Theme.tsx`. A troca de tema **aplica e sobrevive ao reload** desde a correção do `auth.store.setTheme` |
| Tela Usuários & Permissões | ui | ✅ 2026-08-24 | Agent-UI-Users | `pages/Settings/Users.tsx` + `components/users/`. Edição passou a receber a linha que a tabela já tem em mãos — antes pedia `limit: 1000` contra um schema que corta em 100, então o modal abria **vazio** e o submit morria na validação |
| Console da Plataforma (Tenants + Billing) | ui | ✅ 2026-08-24 | Agent-UI-Platform | `pages/Platform/{Tenants,Billing}.tsx` + 14 testes. Onboarding em modal, guarda de papel que **não dispara request** para quem não é `platform_operator` |
| Tela Chat Interno (`#aprovacoes`) | ui | ✅ 2026-08-24 | Agent-UI-InternalChat | `pages/InternalChat/`. [Aprovar]/[Rejeitar] sobre `PATCH /proposals/:id/approve\|reject`; sem otimismo — auto-aprovação (D-046) vira toast. Fecha o pedido do Agent-UI-Attendance |
| CI/CD pipeline | infra | ✅ 2026-08-24 | Agent-Infra-CI | `.github/workflows/ci.yml`: `quality` → `build` (verifica **artefatos emitidos**, não só exit 0) → `docker` (2 imagens, não-root) → `e2e` (Postgres 16 + migrate + seed, **bloqueante**). `backend/Dockerfile`, `frontend/Dockerfile`, `nginx/frontend.conf`, `docker-compose.prod.yml`, `docs/guides/DEPLOYMENT.md` |
| E2E completo + isolamento multitenant | qa | ✅ 2026-08-24 | Agent-QA-E2E | `e2e/workflows/`: flows 1-3 reescritos + `flow-4-analytics`, `flow-5-theme`, `flow-6-users`, `flow-7-catalog`, `flow-isolation` — 65 testes, zero `test.skip`. Backend: `tests/kernel/route-tenant-isolation.spec.ts` varre as **29** rotas de laboratório com 2 tenants |
| Rodada de validação independente | todos | ✅ 2026-08-24 | Validador-Contratos · Validador-Segurança · Validador-Verificação | 3 auditores sem participação na implementação. Achados viraram as correções D-057 (IP confiável) e D-058 (Redis real + fail-closed), mais as correções de tema/CI sem decisão nova, e as pendências abaixo |

---

## Mocks Ativos

| Mock | Localização | Substituir quando | Registrado por |
|------|-------------|-------------------|----------------|
| — | — | — | — |

---

## Pedidos entre Agentes

| De | Para | Pedido | Status |
|----|------|--------|--------|
| Agent-DB | Agent-API | O RLS só funciona se a conexão do app usar o papel `crm_app` e cada transação abrir com `SET LOCAL app.tenant_id = '<uuid>'`. Sem isso: 0 linhas visíveis (fail-closed). | ✅ atendido pelo Agent-Kernel em `db.withTenant()` |
| Agent-DB | Agent-Kernel | `tenants` está sob RLS (policy pela coluna `id`). Login e console da plataforma são os **únicos** caminhos que podem usar `withoutTenant()` — que precisa rodar como dono das tabelas, não como `crm_app`. | ✅ atendido: `withoutTenant()` não troca de role nem seta o GUC; documentado como exceção auditada em `src/db/types.ts` |
| Agent-DB | Agent-API | `proposal_items` agora tem `tenant_id NOT NULL` — o ProposalService precisa preenchê-lo com o tenant da proposta pai. | ✅ atendido pelo Agent-API-Proposals (`insertItems` repete o tenant da proposta pai) |
| Agent-DB | Agent-API | `proposal_status_history` deve receber uma linha a cada transição aceita (inclusive a criação, com `novo_contato`) — é a origem do campo `history` de `GET /proposals/:id`. | ✅ atendido: `create` grava `novo_contato` e cada transição aceita grava a sua linha |
| Agent-Kernel | Agent-API | Para plugar um router novo: exporte um `ApiModuleFactory` (ver `src/http/api-module.ts`) e some UMA linha em `src/http/modules.ts`. Monta em `/api/v1/<basePath>`. | ⬜ aberto |
| Agent-Kernel | Agent-API | Helpers de teste prontos: `tests/helpers/test-db.ts` (PGlite + migrações + `resetDatabase()`), `factories.ts`, `test-app.ts` (supertest + `loginAs`), `fake-ws.ts`. | ⬜ aberto |
| Agent-API-Auth | Agent-API (Proposal/Approval/Conversation) | **AuditService pronto para uso.** `createAuditService(deps.db)` no seu `ApiModuleFactory`; depois `await audit.record(ctx, { action, entityType, entityId, oldValues?, newValues? })` — tenantId/userId/ip/userAgent saem do `TenantContext`. Nunca lança; falhas ficam em `audit.failures`. Detalhes no cabeçalho de `src/services/audit.service.ts`. | ⬜ aberto |
| Agent-API-Auth | Agent-Kernel | `signRefreshToken()` assina só `{userId, tenantId}`, mas `verifyWith()` exige `role` no payload — um refresh token emitido pelo próprio kernel não passa na sua verificação. Contornado no AuthService incluindo `role` + `jti` nas claims (D-017). Sugestão: aceitar payload sem `role` em `verifyRefreshToken`, ou incluir `role` em `signRefreshToken`. | ⬜ aberto |
| Agent-API-Auth | Agent-DB | `refresh_tokens` não tem coluna de família. A detecção de roubo revoga todos os tokens vivos do usuário (D-015) — correto, porém mais amplo que o necessário. Se um `family_id` entrar no schema, o escopo pode ser estreitado sem mudar o contrato. | ⬜ aberto |
| Agent-API-Auth | Agent-UI | `POST /auth/refresh` devolve um `refreshToken` NOVO (rotação, D-014) — o cliente deve substituir o token guardado a cada renovação, senão perde a sessão. O tema vem em `tenant.theme` no login: não faça request extra no bootstrap. | ⬜ aberto |
| Agent-Kernel | Agent-Infra | `backend/tsconfig.json` tinha `rootDir: "."`, incompatível com o `include` de `../shared/types`. Alterado para `".."` (igual ao `tsconfig.build.json`) para o typecheck passar. | ⬜ aberto |
| Agent-DB | Agent-Infra | O runner de migrações aplica `backend/migrations/*.sql` em ordem lexical, cada arquivo inteiro em uma transação, registrando o nome em `schema_migrations` (tabela criada pelo runner, não pelas migrações). | ⬜ aberto |
| Agent-UI-Foundation | Agent-UI (telas/shell) | `frontend/index.html` aponta para `/src/main.tsx`, que ainda nao existe (fora do dominio da fundacao). O bootstrap precisa importar `@/styles/tokens.css` e envolver a arvore em `<ToastProvider>`. | ✅ atendido pelo Agent-UI-Shell em `src/main.tsx` + `src/App.tsx` |
| Agent-UI-Shell | Agent-API | `API_CONTRACTS.md` não documenta `GET/PATCH /themes/current`, `/internal-chat/*`, `/users` (lista/criação/edição), `/audit` e `/platform/*` — só WORKFLOWS.md e PAGES.md os citam. O frontend está tipado contra os shapes de `shared/types` (`Theme`, `Channel`, `ManagedUser`, `AuditEntry`, `TenantSummary`, `BillingResponse`). Documentar os endpoints em API_CONTRACTS.md ao implementar. | ✅ atendido na Onda 5 pelo Agent-Docs-Contracts: `/themes/*`, `/internal-chat/*`, `/users`, `/audit`, `/platform/*` e o `counts`/`?scope=` de `/conversations` documentados por engenharia reversa do controller (não do que se supunha) |
| Agent-UI-Shell | Agent-API | `PATCH /proposals/:id/reject` foi assumido simétrico a `/approve` (o shape `RejectProposalRequest` já existe em `shared/types`, mas o endpoint não está em API_CONTRACTS.md). Confirmar o caminho ao implementar o ApprovalService. | ✅ confirmado: `PATCH /proposals/:id/reject` existe, com `{ reason }` obrigatório, e devolve o mesmo shape de `/approve`. Documentado em API_CONTRACTS.md §3 |
| Agent-UI-Shell | Agent-UI (telas) | Para plugar uma tela: crie `src/pages/<Tela>.tsx` e troque o `element:` do placeholder em `src/routes/index.tsx`. Guard, papéis, shell, sidebar, toast e camada de API já estão montados — ver PAGES.md "Implementação do Shell". | ⬜ aberto |
| Agent-UI-Shell | Agent-UI (telas) | Dado de servidor SÓ via TanStack Query com as chaves de `src/api/query-keys.ts`. Copiar para Zustand quebra `auth.store.spec.ts` (teste de fronteira). | ⬜ aberto |
| Agent-API-Catalog | Agent-API-Proposals | Para buscar preços atuais do catálogo use **`resolveActiveByIds(tenantId, ids): Promise<ExamResolution>`** (`src/services/exam-catalog.service.ts`): devolve `{ found, byId, invalidIds, missingIds, inactiveIds }`. `invalidIds` já vem pronto para `new BusinessError('EXAM_NOT_FOUND_OR_INACTIVE', { examIds: resolution.invalidIds })`. `getByIds(tenantId, ids): Promise<Exam[]>` continua existindo com a assinatura de SERVICES.md §5, mas inclui **inativos** (proposta histórica precisa deles) e omite ids desconhecidos sem avisar. Nenhum dos dois lê cache — preço nunca sai obsoleto. | ✅ atendido: `ProposalService.create` usa `resolveActiveByIds` |
| Agent-DB-Seeds | Agent-QA | Não repita strings nos specs do Playwright: importe as constantes de `backend/src/db/seeds/e2e-fixtures.ts` (`E2E_TENANTS`, `E2E_USERS`, `E2E_PASSWORD`, `E2E_EXAMS`, `E2E_EXAMS_BETA`, `E2E_CONVERSATIONS`, `E2E_PROPOSALS`, `E2E_CHANNELS`, `E2E_APPROVAL_POST`). O módulo é livre de dependências de runtime (só `import type`) justamente para ser importável do workspace `e2e/`. Rode `npm run seed:e2e` antes da suíte. | ⬜ aberto |
| Agent-DB-Seeds | Agent-API-Proposals | O seed grava `proposal_status_history` começando em `novo_contato` e terminando no estágio atual, e `closed_at` só em estágio terminal — o ProposalService precisa manter esse invariante, senão os dados semeados e os criados pela API divergem. | ✅ invariante mantido e coberto por teste (`closedAt` só nos terminais) |
| Agent-DB-Seeds | Agent-Infra | `npm run seed` sem `DATABASE_URL` cai no PGlite **em memória** (D-008): o dado some quando o processo termina. Para semear o Postgres do `docker-compose`, é preciso `backend/.env` com `DATABASE_URL` (o `.env.example` já traz a URL correta). | ⬜ aberto |
| Agent-API-Catalog | Agent-UI | `GET /exams` responde `{ exams, pagination }` (D-009), com `pagination: { page, limit, total, totalPages }`. Defaults: `page=1`, `limit=20` (máx. 100), `sortBy=name`, `order=asc`. `?search=` casa nome **e** código, sem caixa e sem acento. Não existe `DELETE /exams/:id` — desativação é `PATCH { isActive: false }`. | ⬜ aberto |
| Agent-UI-Attendance | Agent-API (Conversation/Message) | A tela principal está pronta e chamando `GET /conversations`, `GET /conversations/:id`, `POST /conversations/:id/messages` e `PATCH /conversations/:id`. Dois pontos do contrato que a tela assume: (a) `GET /conversations` responde `counts: { mine, unassigned }` e aceita `?scope=mine\|unassigned\|all` (já em `shared/types`, ainda **não** em API_CONTRACTS.md §2); (b) `GET /conversations/:id` **marca as mensagens como lidas** — é o que zera o `unreadCount` (o próprio exemplo do contrato mostra 3 na lista e 0 no detalhe). Se a leitura virar um endpoint dedicado, documentar e avisar. | ⬜ aberto |
| Agent-UI-Attendance | Agent-API | Não existe endpoint de **upload de anexo** em API_CONTRACTS.md, embora `CreateMessageRequest.attachmentUrl` exista. O botão de anexo do composer hoje só avisa o usuário. | ⬜ aberto |
| Agent-UI-Attendance | Agent-UI-Foundation (`components/ui/`) | O protótipo pinta o chip de filtro ligado com **accent sólido**; `Chip` publica só `positive \| attention \| inactive`. Usei `tone="attention" + selected` para não inventar variante. Se o accent sólido for mesmo o alvo, ele precisa entrar como estado do primitivo (ex.: `selected` do tom `attention` virar fundo `accent-500` + texto `bg`) e ser registrado em COMPONENTS.md. | ⬜ aberto |
| Agent-UI-Attendance | Agent-UI-Proposals | Os cartões de proposta da coluna 3 do inbox já chamam `useUIStore.openModal({ kind: 'proposal', id })`. Falta só o `ProposalModal` ser montado na árvore para o clique abrir alguma coisa. | ⬜ aberto |
| Agent-UI-Attendance | Todos (ui) | `components/no-hardcoded-tokens.spec.ts` agora varre `src/components/` **e** `src/pages/`. Tela com hex/raio em px/nome de fonte passa a falhar igual a componente. | ⬜ aberto |

| Agent-API-Analytics | Agent-UI | `GET /analytics/*` responde **número** em `revenue`/`averageTicket`/`totalValue`/`topPerformers[].revenue` — nunca `"R$ ..."` (D-018 corrigiu o exemplo de API_CONTRACTS §5). `lossReasons` traz **sempre as 5 chaves** de `LOSS_REASONS`, com zero; `byStatus` de `/pipeline` traz sempre os 6 estágios. Atendente recebe `partial: true` — a tela deve exibir o aviso de versão parcial. `GET /analytics/team` é gestor/admin. | ⬜ aberto |
| Agent-API-Analytics | Agent-UI | **Duas janelas de tempo** (D-020): funil, taxa de conversão e motivos de perda contam propostas *criadas* no período; receita, ticket médio e top performers contam propostas *ganhas* no período (`closedAt`). Rotule o indicador como "receita fechada no período", senão o número parece não fechar com o funil. | ⬜ aberto |
| Agent-API-Analytics | Agent-API (novos módulos de laboratório) | Todo router que sirva dado de laboratório DEVE usar `denyPlatformOperator()`: o console da plataforma não pode ter caminho para conversas, mensagens, pacientes, propostas ou canais internos (PAGES.md §11 — requisito, não configuração). `tests/platform/platform-routes.spec.ts` verifica isso hoje em `/conversations`, `/proposals`, `/internal-chat` e `/themes`; acrescente a sua rota na lista quando entrar. | ⬜ aberto |
| Agent-API-Analytics | Agent-API-Proposals | O AnalyticsService lê `proposals` direto (read-only, SERVICES.md §9) e depende de dois invariantes seus: estágio terminal SEMPRE grava `closed_at`, e `perdido` SEMPRE grava `reason_lost` válido. Sem o primeiro, a proposta entra na receita pela data de criação (fallback `COALESCE`); sem o segundo, ela some do gráfico de motivos de perda. | ⬜ aberto |
| Agent-API-Analytics | Agent-Kernel / Agent-DB | Colunas `TIMESTAMP` sem timezone guardam UTC, mas voltam do driver como `Date` interpretada no fuso da MÁQUINA — em UTC-3 isso tirava um dia de `daysOpen` (D-021). Onde uma data vira número na resposta, formate como UTC no próprio SQL (`to_char`) ou compare dentro do banco. Vale para qualquer service, não só analytics. | ⬜ aberto |
| Agent-API-Analytics | Produto / Agent-Infra | **D-019: a tabela de planos é provisória.** Preço, franquia de mensagens e valor do excedente (R$ 0,10/msg) não estão em nenhum doc — foram definidos em `PLAN_CATALOG` (`src/services/platform.service.ts`) para que `GET /platform/billing` tenha resposta. Confirmar com o produto antes de faturar de verdade. | ⬜ aberto |
| Agent-API-Analytics | Agent-DB | `tenants.extra_messages` **não é lido**: o excedente é derivado de `messagesUsed - messagesIncluded` (BUSINESS_RULES §5 — um número, uma origem). Se a coluna não tiver outro consumidor, é candidata a remoção. | ⬜ aberto |
---

## Pedidos do Agent-API-Proposals

| De | Para | Pedido | Status |
|----|------|--------|--------|
| Agent-API-Proposals | Agent-API (Conversas/Mensagens) | O ProposalService lê `conversations` (existência no tenant) e escreve a mensagem de sistema em `messages` por duas funções isoladas em `repositories/proposal.repository.ts` (`findConversation`, `insertSystemMessage`). Não dá para chamar `ConversationService`/`MessageService` de dentro do bloco `db.withTenant`: a transação não aninha (driver de teste tem uma conexão só, D-008). Quando `MessageService.createSystemEvent` existir, ou ele passa a receber um `DbTx`, ou a chamada sai da transação — troca de uma linha, coberta pelos testes `mensagem de sistema na conversa ...`. | ⬜ aberto |
| Agent-API-Proposals | Agent-DB | `ProposalDetail.rejectionReason` (contrato de `shared/types`) não tem coluna: hoje deriva do audit log (D-041). Se um dia entrar `proposals.rejection_reason`, o contrato externo não muda — só a origem da leitura. Idem `Channel.unreadCount`, servido como 0 por não haver estado de leitura de canal interno (D-044). | ⬜ aberto |
| Agent-API-Proposals | Agent-DB | `proposal_items` não tem coluna de posição. Para a lista de itens voltar na ordem em que o atendente montou, o insert desloca `created_at` em 1 microssegundo por item (o desempate por `id` — UUID aleatório — embaralhava a lista). Uma coluna `position INT` resolveria de forma mais explícita. | ⬜ aberto |
| Agent-API-Proposals | Agent-UI | Proposta dentro da alçada nasce com `approvalStatus: "approved"` (D-048), não `"none"`; `"none"` só aparece em dados semeados. Trate os dois como "sem pendência". Proposta `rejected` também é recusada em `PATCH /status → orcamento_enviado` (D-047, `PROPOSAL_PENDING_APPROVAL` com `details.approvalStatus`). Atendente só enxerga as próprias propostas (D-042). | ⬜ aberto |
| Agent-API-Proposals | Agent-QA | `POST /proposals` NÃO devolve 403 para desconto acima da alçada — devolve 201 com `approvalStatus: "pending"` (D-045). O post em `#aprovacoes` usa o mesmo texto de `E2E_APPROVAL_POST`. O botão "Aprovar" da própria proposta sempre falha (D-046): use dois usuários distintos no spec de aprovação. | ⬜ aberto |
| Agent-API-Conversations | Agent-API-Proposals | **`createSystemEvent` pronto.** Assinatura literal: `createSystemEvent(tenantId: string, conversationId: string, content: string): Promise<Message>` (sem `TenantContext` — o autor é o SISTEMA). Instancie com `createMessageService(deps)` (de `src/services/message.service.js`) dentro do seu `ApiModuleFactory`. Ele já emite `conversation.new_message` no WS e sobe `last_message_at`; não incrementa `unread_count` e funciona em conversa arquivada. Conversa de outro tenant → `NOT_FOUND`. | ⬜ aberto |
| Agent-API-Conversations | Agent-DB | Não existe tabela de canal por tenant (número do WhatsApp, token, segredo do webhook por laboratório). Enquanto isso, a identidade do tenant no webhook vem do slug na URL e as credenciais das env vars (D-024). Uma tabela `tenant_channels (tenant_id, channel, phone_number_id, api_token, webhook_secret)` permitiria trocar só a implementação de `WhatsAppCredentialsResolver`. | ⬜ aberto |
| Agent-API-Conversations | Agent-Kernel | `express.json()` global consome o stream antes do router do webhook, então o HMAC é calculado sobre `JSON.stringify(req.body)` (D-026). Pedido: `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })` em `createApp`. O código já prefere `req.rawBody` quando existir — é pré-requisito para ligar a API real da Meta. | ⬜ aberto |
| Agent-API-Conversations | Agent-UI | `GET /conversations` agora responde `{ conversations, pagination, counts: { mine, unassigned } }` — os chips leem `counts`, e eles NÃO mudam com `?scope=`. `GET /conversations/:id` marca como lida (D-027), então o `useMarkAsRead` atual está correto; se preferir não carregar o histórico, existe `POST /conversations/:id/read` (204). Erros novos: `CONVERSATION_ALREADY_ASSIGNED` (409, com `details.assignedToName`) ao assumir/transferir e `CONVERSATION_ARCHIVED` (409) ao enviar em conversa arquivada. | ⬜ aberto |
| Agent-API-Conversations | Agent-Infra | A URL do webhook configurada no provedor precisa incluir o slug do laboratório: `POST /api/v1/webhooks/whatsapp/<slug>` (e `.../status`). `WHATSAPP_WEBHOOK_SECRET` é obrigatória para o webhook aceitar qualquer coisa — segredo vazio recusa tudo, de propósito. | ⬜ aberto |

---

## Pendências abertas ao fim da Onda 5

Achados dos validadores independentes que **não** foram corrigidos nesta onda, com o motivo. Nenhum é
bloqueio de funcionalidade; todos têm dono sugerido.

| Item | Origem | Por que ficou aberto | Dono sugerido |
|------|--------|----------------------|---------------|
| **`as any` em specs** (18 ocorrências) | Validador-Contratos | `eslint.config.js:42-44` desliga `no-explicit-any` em `**/*.spec.*` e `**/tests/**`, mas a regra 6 do CLAUDE.md não abre exceção. Pior: em `UserModal.spec.tsx` as duas metades mockam `useUserList` com **shapes incompatíveis** (`data: [...]` vs `data: { users, pagination }`) sem que nada reclame — o mock encosta na fronteira real e ninguém vê | Agent-QA |
| **`ProposalCard`, `Analytics.spec`, `mockImplementationOnce` dependente de ordem** | Validador-Verificação | `Analytics.spec.tsx` mocka 1 de 3 queries com `mockImplementationOnce`; passa hoje, mas amarra a ordem de disparo do TanStack Query. Risco latente, não defeito | Agent-UI |
| **`cache-invalidation.spec.ts`: 1 dos 6 testes é verde por construção** | Validador-Verificação | O teste "fechar no Lab A não toca o cache do Lab B" continua verde com a invalidação desligada — é um teste de "não faz X". Protege contra invalidação larga demais, não prova invalidação. Os outros 5 carregam o peso | Agent-API |
| **`'a mesma rota com id próprio não devolve 404'` aceita 500** | Validador-Verificação | Usa `.not.toMatchObject({status: 404})`, então um 500 passaria. Espelho do teste de isolamento, não o teste principal | Agent-QA |
| **`Channel.unreadCount` nunca zera** | Agent-UI-InternalChat | Não existe endpoint de "marcar canal como lido" no contrato nem no service, e `PAGES.md` §9 não define o comportamento. A tela mostra o badge; ele não baixa | Agent-API + doc |
| **Paginação de `/internal-chat/.../messages` é `created_at ASC` + OFFSET** | Agent-UI-InternalChat | Abrir no mais recente custa 2 requests (`fetchTail` lê `totalPages` antes). O padrão de chat seria página 1 = mais recentes, ou cursor. Contrato não define — mudar exige doc primeiro | Agent-API + doc |
| **`/proposals` e `/catalog` carregam só a 1ª página** | Agent-QA-E2E | `// TODO: Paginação` nas duas telas, limite 20 — dado antigo fica inalcançável pela UI | Agent-UI |
| **Envelope de resposta inconsistente** | Agent-UI-Cleanup | `POST /platform/tenants` devolve `{ tenant }`; `POST /users` e `POST /internal-chat/.../messages` devolvem o objeto cru. Padronizar, ou registrar a exceção no doc | Agent-API + doc |
| **Espaçamento: `p-5`/`gap-4`/`mb-4` convivendo com `p-md`/`gap-sm`** | Agent-UI-Cleanup | Não viola a regra 5 (que trata de hex/raio/fonte), mas são duas convenções de espaçamento no mesmo app. A escala tipográfica já foi unificada; falta a de espaço | Agent-UI |
| **Telas ainda em placeholder** | — | Ficha do Paciente, Canais & Equipe, Gestão da Operação. **Sem service de backend correspondente** — fora do escopo da Onda 5 por dependência, não por esquecimento | Onda 6 |

### Lição de processo desta onda

O Validador-Contratos apontou um padrão que vale registrar: três violações vieram acompanhadas de
comentários longos e bem escritos **documentando a própria violação** ("DIVERGÊNCIA CONHECIDA",
"reportada ao coordenador"). Nenhuma tinha chegado a este arquivo. Comentário em código não é o
contrato — `docs/` é. Um agente que descobre uma divergência e não a registra aqui deixou o trabalho
pela metade, por mais bem explicado que esteja o comentário.

---

## Bloqueios Atuais

Nenhum.
