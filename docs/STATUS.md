# 📊 STATUS do Projeto

Arquivo de coordenação vivo. Todo agente atualiza aqui ao reivindicar, avançar ou concluir tarefas.

**Última atualização:** 2026-09-18 (`/results`: evolução do faturamento + donut no recebido — ver seção no fim)

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

## Onda 6 — Paciente, Operação e Fechamento de Pendências ✅ (concluída em 2026-08-25)

Fecha as três telas que a Onda 5 deixou em placeholder — que estavam paradas por **não existir
service de backend**, não por esquecimento — e as dez pendências dos validadores.

| Tarefa | Domínio | Status | Agente | Notas |
|--------|---------|--------|--------|-------|
| Contratos da onda (Fase 0, bloqueante) | docs | ✅ 2026-08-25 | Agent-Docs-Onda6 | API_CONTRACTS §2c/§6/§7, SERVICES §12-§14, SCHEMA §14-§17, `shared/types/{patient,settings,operation}.types.ts`, D-059→D-071. Nenhuma linha de implementação antes disto (Regra Zero) |
| Migração 003/004 + backfill + seeds | db | ✅ 2026-08-25 | Agent-DB-Onda6 | `patients`, `tenant_channels`, `tenant_settings`, `channel_reads`, `conversations.patient_id`, `proposal_items.position`. RLS fail-closed nas 4 novas. O teste do backfill monta um banco só com 001/002, escreve dado "pré-Onda 6" e **só então** aplica 003/004 — no banco de teste compartilhado o backfill passaria por vacuidade |
| PatientService + timeline + LGPD | api | ✅ 2026-08-25 | Agent-API-Patients | `GET/PATCH /patients[/:id]`, `/timeline`, `/export`, `/anonymize`. O recorte por papel (D-060) vive no MESMO `LATERAL` que produz os contadores — é estruturalmente impossível o contador dizer 4 e a listagem enxergar 2 |
| ChannelSettingsService + OperationService | api | ✅ 2026-08-25 | Agent-API-Operation | `GET/PATCH /settings/channels`, `GET /operations/overview`. Máscara do segredo montada no SQL; tudo da operação derivado de `conversations`+`proposals`, sem contador materializado |
| Leitura de canal, paginação do chat, envelope, `?patientId=` | api | ✅ 2026-08-25 | Agent-API-Fixes | D-068, D-069, D-070 e o teste de cache que era verde por construção |
| Vínculo paciente↔conversa e credenciais por tenant | api | ✅ 2026-08-25 | Agent-API-Link | D-072, D-073. Corrigiu de passagem um bug pré-existente: o upsert de paciente usava CTE com JOIN de volta e **nenhum paciente novo era retornado** — só o caminho `DO UPDATE` funcionava, e o método ainda não tinha consumidor |
| Ficha do Paciente | ui | ✅ 2026-08-25 | Agent-UI-Patient | `pages/Patients/Profile.tsx`. `switch` exaustivo na timeline (uma 5ª espécie quebra o typecheck em vez de renderizar vazio); PATCH por diferença; LGPD com confirmação dupla |
| Canais & Equipe + Gestão da Operação | ui | ✅ 2026-08-25 | Agent-UI-Operation | Para o gestor os controles de escrita **não existem** no DOM (não são `disabled`). Canal intocado não entra no corpo do PATCH — senão o 1º "salvar" criaria canal fantasma |
| Paginação, escala de espaçamento, mocks tipados | ui | ✅ 2026-08-25 | Agent-UI-Cleanup | D7, D2, D9, D1 (metade de frontend). 57 ocorrências de espaçamento unificadas; `no-hardcoded-tokens.spec.ts` estendido para reprovar espaçamento cru |
| E2E das telas novas + isolamento das rotas novas | qa | ✅ 2026-08-25 | Agent-QA-Onda6 | Flows 8-12; inventário de isolamento 30 → 39 rotas; D4 fechado com `ownStatus` por rota + meta-teste que reprova rota nova sem declaração |
| Correções pós-QA no frontend | ui | ✅ 2026-08-25 | Agent-UI-Fixes-Onda6 | A tela do chat **nunca chamava** `POST /read` (o backend fechou D-068 e a UI não ligou o fio); `fetchTail` obsoleto pela D-069; `SearchInput` derrubava a paginação |
| Rodada de validação independente | todos | ✅ 2026-08-25 | Validador-Contratos · Validador-Segurança · Validador-Verificação | 3 auditores sem participação na implementação. 2 críticos, 3 altos e ~12 médios — todos corrigidos nas Fases 5/6 abaixo |
| Correções dos validadores | vários | ✅ 2026-08-25 | Agent-Fix-{Entrypoint,Contracts,Security,Evidence} | D-074→D-079 + emendas a D-063 e D-073 |
| Catálogo do orçamento e poluição de teste | ui/qa | ✅ 2026-08-25 | Agent-Fix-Budget | D-080. Achado pelo coordenador ao rodar a suíte E2E **completa** — ver lição abaixo |

**Verificação final, rodada pelo coordenador (não pelos autores):**

| Comando | Resultado |
|---------|-----------|
| `npm run typecheck` (4 workspaces) | verde |
| `npm run lint` | limpo |
| `npm run test:backend` | 43 arquivos · **674** testes |
| `npm run test:frontend` | 52 arquivos · **728** testes |
| `npm run e2e` (suíte completa, banco resemeado) | **103 passed**, 0 failed, 0 skip |

### Lição de processo desta onda

**Nove agentes e três validadores viram verde; a suíte completa não estava verde.** Cada agente rodou
os fluxos do próprio escopo, e o `flow-12` criava 25 exames por execução sem limpá-los — o Playwright
roda em ordem alfabética, então `flow-12` corre **antes** de `flow-2` e `flow-isolation`, e o exame que
esses dois clicam era empurrado para fora da primeira página do seletor. Ninguém tinha como ver isso
olhando só o próprio escopo.

Debaixo da poluição havia um defeito de produto real: o catálogo da tela de Novo Orçamento carregava
só a primeira página. É a **mesma pendência D7** que a onda fechou em `/proposals` e `/catalog` — e
que ninguém levou para a terceira tela que lista exames, porque a pendência foi escrita com nome de
tela em vez de nome de comportamento. Laboratório com mais de 50 exames ativos não conseguia montar
orçamento com o resto.

Duas regras que ficam: **(1)** quem coordena roda a suíte inteira antes de declarar a onda fechada —
verde por escopo não compõe; **(2)** pendência se escreve pelo comportamento ("listagem sem paginação"),
não pela tela onde ela foi vista, senão o fechamento para na primeira ocorrência conhecida.

O padrão da Onda 5 — divergência documentada em comentário e nunca registrada em `docs/` — reapareceu
duas vezes, em menor escala, e o Validador-Contratos pegou as duas: `proposal.repository.ts` afirmava
que `proposal_items` não tinha coluna de posição (falso desde a migração 003, do mesmo commit) e
`flow-11` afirmava que a tela não chamava `POST /read` (falso desde a correção pós-QA). Comentário
não é contrato.

---

## Onda 7 — Convênios/TUSS, Conexão WhatsApp por QR e Fechamento de Pendências 🔄 (em andamento)

Convênio como entidade + preço por convênio + TUSS/AMB + sinônimos + material no catálogo
(pedido da integração Bitlab Fase 1 — Trilha A); conexão do WhatsApp do próprio laboratório via
QR code (Evolution API), sem depender da API oficial da Meta; e as 7 pendências do Bloco C do
spec. Plano: `docs/superpowers/plans/2026-08-30-onda-7.md`. Spec:
`docs/superpowers/specs/2026-08-30-onda-7-design.md`.

| Tarefa | Domínio | Status | Agente | Notas |
|--------|---------|--------|--------|-------|
| Contratos da onda (Fase 0, bloqueante) | docs | ✅ 2026-08-30 | Agent-Docs-Onda7 | API_CONTRACTS §4 estendido/§6.1 QR/§8 novo (Convênios), SERVICES §15-§16, SCHEMA §18-§20 + colunas novas em `exam_catalog`/`proposals`/`proposal_items`/`tenant_channels`, `shared/types/insurance.types.ts` (novo) + `exam`/`proposal`/`settings.types.ts` estendidos, nota de risco em SECURITY.md, D-081→D-085. Nenhuma linha de implementação antes disto (Regra Zero). **Por decisão do coordenador, `websocket.types.ts` e o campo `message` de `proposal.types.ts` NÃO foram tocados nesta fase** — a remoção fica para as tasks de código da Fase 2, no mesmo commit que remove o código consumidor (D-084/D-085), para não quebrar o typecheck das demais tasks paralelas |
| Migrações 005/006, seeds enriquecidos, fixtures e2e | db | ✅ 2026-08-30 | Agent-DB-Onda7 | Fase 1, bloqueante. `insurances`, `exam_prices`, `exam_synonyms` + colunas novas em `exam_catalog`/`proposals`/`proposal_items`/`tenant_channels`; RLS fail-closed provada com 2 tenants (20/20 testes novos, `tests/db/migration-005-006.spec.ts` + `tests/db/rls-onda7.spec.ts`); seed de 20 convênios (Apêndice A) nos 2 tenants de dev; 82 exames do catálogo enriquecidos com TUSS (58 confirmados, resto `NULL`), material e sinônimos (Apêndice B/C); `E2E_INSURANCES`/`E2E_EXAM_PRICES` novos em `e2e-fixtures.ts`. DDL do brief e do SCHEMA.md §18-§20 divergiam em detalhes menores (nome de constraint, um índice e um CHECK a mais); SCHEMA.md tratado como autoritativo (Fase 0 fechada) — ver `task-1-report.md` |
| `/insurances` + preços + sinônimos na busca + extensões `/exams` | api | ✅ 2026-08-30 | Agent-API-Insurances + Agent-API-Catalog7 | Fase 2. `InsuranceService`/`/insurances` (Task 2) prontos antes; Task 3 (Agent-API-Catalog7) acrescentou ao catálogo: `tussCode`/`ambCode`/`material`/`source`/`synonyms` no `create`/`update` (regravados por delete-then-insert em `exam_synonyms`, mesma transação); busca (`?search=`) casando nome/código/sinônimo sem caixa/acento; `listPrices`/`upsertPrices` (dono de `exam_prices`, delete-then-insert transacional, auditado `update_exam_prices`); `list`/`resolveActiveByIds` com `insuranceId` acrescentando `effectivePrice`/`priceSource` com fallback para `pricePrivate` (nunca bloqueia); `GET/PUT /exams/:id/prices`. 70 testes novos/estendidos em `backend/tests/catalog/`, suíte inteira do catálogo verde; inventário de isolamento (`route-tenant-isolation.spec.ts`) estendido para 44 rotas. Ver `task-3-report.md` |
| `insuranceId` na proposta + resolução/fallback + snapshot `priceSource` | api | ✅ 2026-08-30 | Agent-API-Proposals7 | Fase 2. `ProposalService.create` aceita `insuranceId?` (null/ausente = particular); preço resolvido via `ExamCatalogService.resolveActiveByIds(..., insuranceId)` (Task 3) com fallback automático para `pricePrivate`/`priceSource:'private'` quando o exame não tem preço cadastrado para o convênio — fallback nunca bloqueia o orçamento. `insuranceId` inexistente/de outro tenant/inativo → `VALIDATION_ERROR` (checado via `InsuranceRepository.findById`, sob RLS). `PATCH` de proposta continua sem campo `insuranceId` — imutável após a criação. `proposal_items.price_source` e `proposals.insurance_id` gravados no snapshot; corrige os 2 erros de typecheck que eram desta task. 8 testes novos em `backend/tests/proposals/proposal-insurance.spec.ts`; suíte inteira de propostas (77 testes) e suíte completa do backend (771 testes) verdes. Ver `task-4-report.md` |
| Driver Evolution + endpoints connect/qr/status/disconnect + webhook | api | ✅ 2026-08-30 | Agent-API-Channel-QR | Fase 2. `EvolutionWhatsAppDriver` (§11) selecionado por `tenant_channels.connection_mode`; `evolution-client.ts` fala com o gateway self-hosted (`/instance/create`, `/instance/connect`, `/instance/connectionState`, `/instance/logout`, `/message/sendText` — os 5 endpoints e os formatos de resposta assumidos documentados em SERVICES.md §16.1); as 4 rotas `/settings/channels/whatsapp/*` (`ChannelSettingsService` §13/§16, admin, `denyPlatformOperator()`); webhook público `POST /webhooks/evolution/:tenant` (+`/status`) reusando `findOrCreateByPhone`/`createFromPatient`; `CHANNEL_QR_UNAVAILABLE` (503) mapeado em `http/errors.ts`, fechando os 5 erros de typecheck pendentes desde a Task 2. **Rodada de correção 1/5 (revisão ❌ 2 Critical, 4 Important, 5 Minor) endereçada no mesmo dia:** Critical 1 (`markWhatsAppDisconnected` zerava `is_active`, o próprio kill switch do webhook — canal ficava travado para sempre após desconectar/reconectar); Critical 2 (webhook só aceitava header `apikey`, não o `x-evolution-webhook-token` documentado — agora aceita os dois); Important 3 (`EVOLUTION_WEBHOOK_TOKEN` ausente não bloqueava as 4 rotas); Important 4 (payload `instance` do webhook agora é conferido contra `evolutionInstanceName(tenantId)` antes de escrever — fecha substituição de slug com o token da instalação); Important 5 (`connect` aceita aceite prévio, não só `acceptTerms: true` no corpo; `accepted_terms_at`/`by` deixam de ser reescritos a cada reconexão); Important 6 (`sendText` passa a usar a apikey da INSTÂNCIA, não a apikey admin do gateway); Minor 7 (`getQr` não confia mais num `status` inventado — narrado por `statusOf`/`instance.state`, igual a `getStatus`); Minor 9 (kill switch, reconexão-após-desconexão e as 3 auditorias agora têm teste; cifra em repouso provada com `CHANNEL_SECRET_KEY` de verdade, não só `toBeTruthy()`). Minor 8 (`phoneNumber` best-effort, sem `/instance/fetchInstances`) e Minor 11 (`Headers` latente) diferidos por decisão do coordenador. 39 testes na área (evolution-client/connect/webhook), backend completo 814/814, inventário de isolamento 44→48. Ver `task-5-report.md` |
| HMAC sobre `rawBody` (C1) + `MAX_PAGE` restante (C2) + remoção de `message` (C7) + contrato de `oldestWaitSeconds` (C5) | api/kernel/docs | ✅ 2026-08-30 | Agent-Fix-Pendencias | Fase 2. **C1:** `express.json({ verify })` grava `req.rawBody`; `rawBodyOf` (webhook.routes.ts) já preferia esse campo — nenhuma mudança lá. Teste novo (`tests/webhooks/rawbody-hmac.spec.ts`) usa um corpo com espaços após `:`/`,` que a reserialização (`JSON.stringify`) sempre perde, provando que a comparação precisa ser contra os BYTES reais, não qualquer reserialização (mesma ordem de chaves incluída). **C2:** `MAX_PAGE = 10_000` em `conversation`/`platform`/`internal-chat`/**`exam-catalog`** (as 4 que ainda usavam `Number.MAX_SAFE_INTEGER` — `exam-catalog.service.ts` não estava no brief, mas o próprio teste do brief cobre as 4; sem o fix lá o teste ficaria vermelho para sempre). **C7:** `message` removido de `CreateProposalResponse` (agora alias de `ProposalDetail`) e de `ProposalService.create`; `PENDING_APPROVAL_MESSAGE` apagado (sem outro consumidor); API_CONTRACTS.md §2/§3 atualizado. **C5:** `SERVICES.md §14` documenta que `oldestWaitSeconds` vem de `MAX(CONVERSATION_WAIT)` sobre a fila INTEIRA (`operation.repository.ts#queueTotals`) — **não** de uma ordenação dos itens paginados; a premissa de Onda 6 ("distinguível só por `ORDER BY ... DESC NULLS FIRST`") não correspondia ao código real (que usa `MAX()`, não uma leitura do topo de uma lista ordenada) e foi corrigida na documentação. `npm run typecheck --workspace backend` verde; suíte de propostas (77 testes) verde; frontend segue com os mesmos 9 erros de typecheck pré-existentes (fixtures de Tasks 7/8/9, não tocadas). Ver `task-6-report.md` |
| Convênios + Catálogo (UI) | ui | ✅ 2026-08-30 | Agent-UI-Catalog7 | Fase 2. `/settings/insurances` (rota gestor+): tabela + modal criar/editar (nome, razão social, ANS, tipo via `Select`, ativo via `Toggle` — só em edição, `POST` não aceita `isActive`); botão "Novo Convênio" e coluna de ações ausentes do DOM para quem não é manager/admin (padrão de `Settings/Channels.tsx`). `api/insurances.ts` novo (`insurancesApi` + `useInsuranceList`/`useCreateInsurance`/`useUpdateInsurance`), chaves `insurances`/`insurance`/`exam-prices` em `query-keys.ts`. `api/exams.ts` estendido com `examsApi.prices`/`updatePrices` + `useExamPrices`/`useUpdateExamPrices` (`GET`/`PUT /exams/:id/prices`). `ExamTable` ganhou colunas TUSS e material; `ExamModal` ganhou os campos TUSS/AMB/material, sinônimos como chips removíveis e, em modo edição, uma segunda aba "Preços por convênio" (`SegmentedControl`) que troca o corpo do modal por `ExamPricesTab` (grid convênio × preço novo, PUT em lote — linha em branco é removida, não preservada; só existe em edição porque não há `examId` em criação). Rota plugada em `route-config.ts`/`routes/index.tsx` (+ ícone `insurances` em `NavGlyph.tsx`, exigido pelo `Record<NavIcon,string>`). Fixa os 3 erros de typecheck que eram desta task (fixtures de `Exam` sem `tussCode`/`ambCode`/`material`/`source`/`synonyms` em `CatalogSegments.spec.tsx`, `ExamModal.spec.tsx`, `Catalog.spec.tsx`) — `npm run typecheck --workspace frontend` fecha em exatamente 6 erros, todos das Tasks 8/9. 24 testes novos (`Insurances.spec.tsx` ×6, `ExamModal.spec.tsx` +4, `Catalog.spec.tsx` +1, `ExamPricesTab.spec.tsx` ×4); suíte completa do frontend 54 arquivos/751 testes verde; `no-hardcoded-tokens.spec.ts` verde. `docs/api/API_CONTRACTS.md` §8/§4 e `PAGES.md` §7/§10 já documentavam os endpoints (Task 2/3); `PAGES.md` recebeu a seção "Convênios" e a extensão do catálogo. Ver `task-7-report.md` |
| Seletor de convênio + badges no orçamento | ui | ✅ 2026-08-30 | Agent-UI-Budget7 | Fase 2. `InsuranceSelector.tsx` novo (`Select` sobre `useInsuranceList({ active: true })`, opção fixa "Particular" no topo mapeando para `insuranceId: null` — nunca vem da API, D-082); montado dentro de `CatalogSegments`, substituindo o antigo toggle local "Particular/Convênio" (que fixava o preço na tela sem refletir o convênio real da proposta — duas fontes de verdade). `CatalogSegments` recebe `insuranceId`/`onInsuranceChange` de `Budget/New.tsx`, propaga para `useExamListInfinite({ ..., insuranceId })` e exibe `exam.effectivePrice ?? exam.pricePrivate`; `onAddItem` ganhou um 4º parâmetro `priceSource` (`exam.priceSource` quando há convênio, `'private'` sem ele). `SummaryColumn`/`BudgetItem` carregam esse `priceSource` por item e mostram um `Chip` "Particular" só quando `insuranceId` está setado E o item caiu no fallback particular (com `insuranceId` null todo item já é particular — o badge seria redundante); `useCreateProposal` recebe `insuranceId` no payload (`CreateProposalRequest` já tinha o campo desde a Fase 0 — nenhuma mudança em `api/proposals.ts`). `ProposalModal` resolve o nome do convênio via `useInsuranceList({ limit: 100 })` (sem `active`, para alcançar convênio já desativado) — `Proposal`/`ProposalDetail` não embutem `insuranceName`, então o header mostra "Convênio" por um instante até a lista carregar (ajuste de UX menor, não bloqueante); `ItemsList` ganhou o mesmo badge por item. Fecha os 5 erros de typecheck que eram desta task (fixtures sem `priceSource`/`insuranceId` em `ProposalModal.spec.tsx`, `Proposals.spec.tsx`, `Patients/Profile.spec.tsx`, `InternalChat.spec.tsx`) + 2 erros achados fora da lista do brief (`CatalogSegments.spec.tsx`, que já existia e não estava listado nos 6, e `CatalogSegments.spec.tsx` de novo pela mudança de assinatura de `onAddItem`) — `npm run typecheck --workspace frontend` fecha em exatamente 1 erro, de `Settings/Channels.spec.tsx` (Task 9, não tocado). 3 testes novos em `Budget/New.spec.tsx`; suíte completa do frontend 54 arquivos/758 testes verde; `no-hardcoded-tokens.spec.ts` verde. Ver `task-8-report.md` |
| Modal QR + termo de aceite | ui | ✅ 2026-08-31 | Agent-UI-Connect | Fase 2. `WhatsAppConnectModal.tsx` novo: termo de risco (banimento, ToS, número dedicado, reabrir o app a cada ~14 dias, dado de saúde no gateway) + checkbox obrigatório — pulado quando `acceptedTermsAt` já vem setado (reconexão), mas o corpo continua `{ acceptTerms: true }` porque o tipo compartilhado não tem variante parcial e o servidor aceita esse caminho de qualquer forma; ao conectar, liga `useWhatsAppQr({ enabled: true })`, mostra o QR (`<img alt="QR Code do WhatsApp">`) com contagem regressiva; `status: 'connected'` (mesmo com `qrcode: null`, comportamento do backend) fecha o modal e dispara toast; `status: 'disconnected'` depois de ter passado por `pairing` mostra "Gerar novamente"; `503 CHANNEL_QR_UNAVAILABLE` (de `connect` ou do polling) mostra mensagem honesta, nunca spinner infinito. `api/channels.ts` novo: os 4 hooks do brief + `qrRefetchInterval` extraída como função pura (`(query) => error ? false : status === 'pairing' ? 2000 : false`) e testada isolada de React Query (`channels.spec.ts`, 5 testes) — é a prova de que o polling para no terminal e no erro, não só leitura de código. `Channels.tsx`: bloco "Conexão por QR" dentro do cartão do WhatsApp, só para `canEdit` (as 4 rotas são admin-only, então nem o `GET /status` sai para quem não é); conectado mostra `Conectado — <telefone>` (telefone pode faltar, D-083) + "Desconectar" com confirmação em `Modal` explicando que `is_active` não muda. Corrigido o `TenantChannel` sem `connectionMode`/`acceptedTermsAt` de `Channels.spec.tsx` (o 1 erro de typecheck que era desta task) + `@/api/channels` mockado ali (hooks rodam a cada render do cartão, independente do modal estar aberto) + `ToastProvider` no `renderPage` (o bloco novo usa `useToast`). `npm run typecheck` fecha em **0 erros nos 4 workspaces** — primeira vez na onda. 11 testes novos (`WhatsAppConnectModal.spec.tsx` ×5, `channels.spec.ts` ×5, `Channels.spec.tsx` +2); suíte completa do frontend 56 arquivos/778 testes verde; `no-hardcoded-tokens.spec.ts` verde (325 casos). Duas asserções do brief quebravam por render incidental (a sequência `mockReturnValueOnce` ×2 é consumida pelo re-render do clique no checkbox antes mesmo do clique em "Conectar", e o 3º teste era só um comentário sem corpo) — reescritas como mock controlado por `enabled`/`rerender` explícito, comportamento idêntico ao descrito, sem depender de contagem de renders. Ver `task-9-report.md` |
| `docker-compose` + env vars + CI | infra | ✅ 2026-08-31 | Agent-Infra7 | Fase 2. Serviço `evolution` em `docker-compose.yml`/`.prod.yml` (D-083, v2.3.7). **Brief tinha 3 erros corrigidos por verificação, não por confiança:** (1) imagem `evoapi/evolution-api` não existe em registry nenhum — o org correto é `evoapicloud` (confirmado no `docker-compose.yaml` oficial do repo `EvolutionAPI/evolution-api` e na API do Docker Hub, que também lista `v2.3.7` publicada); (2) `DATABASE_CONNECTION_URI` apontava pro banco `evolution`, que o compose nunca cria (só provisiona `POSTGRES_DB=crm_lab`) — `postgres-init/01-evolution-db.sh` novo, montado em `/docker-entrypoint-initdb.d` dos dois composes, cria `evolution` no primeiro init do volume (idempotente, `CREATE DATABASE ... WHERE NOT EXISTS`); (3) credenciais do brief (`crm_owner`/`crm_password`) não batiam com as reais do serviço `postgres` (usuário `crm`, ver `docker-compose.yml`) — corrigido para usar as de verdade (dev) / `${POSTGRES_USER}`/`${POSTGRES_PASSWORD}` (prod, já obrigatórias). `redis` já existia no compose, sem mudança. Prod: `evolution` **sem `ports:`** (D-051 — só o nginx do frontend expõe porta; admin API do gateway exposta publicamente com chave conhecida é sequestro do WhatsApp do laboratório); `AUTHENTICATION_API_KEY`/`EVOLUTION_API_KEY` com placeholder óbvio (`dev-local-placeholder-key` em dev, `troque-esta-chave-antes-de-usar` em prod), nunca segredo real; as 3 vars `EVOLUTION_*` também acrescentadas ao `backend` do `docker-compose.prod.yml` (mesmo padrão opcional-vazio de `WHATSAPP_API_*` — não estava no brief, mas sem isso o gateway ficaria inalcançável do backend em produção mesmo depois de implantado). **Verificado ao vivo** (Docker disponível no ambiente): `docker compose up -d postgres redis evolution` — imagem `evoapicloud/evolution-api:v2.3.7` puxada, banco `evolution` criado, migrações do gateway aplicadas, Redis conectado, `curl -H "apikey: dev-local-placeholder-key" http://localhost:8080/instance/fetchInstances` → `200 []` como esperado; `docker compose down` ao final. `docker compose config` também validado nos dois arquivos. CI (`ci.yml`) não precisou de mudança: o job de e2e não usa `docker-compose.yml` (sobe Postgres via `services:` do GitHub Actions + `npm run dev`) e nunca referencia Evolution — `EVOLUTION_API_URL` vazio já desliga a funcionalidade sem erro (fail-soft, `backend/src/config/env.ts`). `backend/.env.example` já tinha as 3 vars da Task 5 — não tocado de novo. **+ as 4 pendências carregadas:** C3 (`MetricTile.tsx` percent em pt-BR — ver nota na tabela de pendências: o brief pedia `Intl` `style:'percent'` com teste `value={0.3}`, mas `conversionRate` do contrato já vem em PONTOS percentuais, não fração — `style:'percent'` dobraria a escala pra quem chama de verdade (`Analytics.tsx`, `conversionRate: 30`); implementado como `Intl.NumberFormat('pt-BR', {minimumFractionDigits:1})` + `%` manual, preservando a escala e só corrigindo o separador decimal; `Analytics.spec.tsx` atualizado de `'30.0%'` para `'30,0%'`); C6 (`user.came_online` removido atomicamente de `shared/types/websocket.types.ts` + `case` órfão de `frontend/src/api/ws.ts` + `backend/tests/kernel/ws-hub.spec.ts` (usava o evento como fixture, trocado por `approval.requested`) + documentação (`API_CONTRACTS.md`, `ARCHITECTURE.md`)); C4 (comentário obsoleto de `flow-7-catalog.spec.ts` removido). `npm run typecheck` verde nos 4 workspaces; backend 827/827, frontend 782/782 (778 + 4 novos em `MetricTile.spec.tsx`, que não existia); `no-hardcoded-tokens.spec.ts` verde. Ver `task-10-report.md` |
| E2E das telas novas + inventário de isolamento (39 → 48 rotas) | qa | ✅ 2026-09-03 | Agent-QA-Onda7 | Fase 3. `flow-13-insurances` (preço por convênio cadastrado na aba do catálogo → cobrado no orçamento; fallback para particular no MESMO orçamento, com badge na tela e `priceSource` no snapshot; convênio persistido no modal) e `flow-14-whatsapp-connect` (termo → QR → conectado contra `fake-evolution-gateway.ts`, servidor HTTP real na porta do compose). `flow-1` ganhou a regressão explícita do orçamento **particular**. Inventário de isolamento já estava em **48** rotas e verde. **Três achados que só a suíte completa revelou:** (1) o fluxo 14 no tenant Alfa deixava `connection_mode='qr'` e o envio de mensagem do fluxo 8 passava a responder 502 depois que o gateway do arquivo morria — daí a fixture `betaAdmin` e a mudança de tenant; (2) `getByLabel('Código')` do fluxo 7 ficou ambíguo quando a Onda 7 acrescentou TUSS/AMB ao modal; (3) `getByText('Receita')` do fluxo 4 casa a legenda do gráfico quando há receita no período — passava ou falhava conforme o dado do dia |
| Documentação final de domínio e STATUS | docs | ✅ 2026-09-03 | Agent-Docs-Fechamento7 | Fase 3. `PAGES.md` §10 ganhou a subseção "Conexão por QR" (termo → QR → conectado → desconectar, polling que para sozinho, aceite como dado do canal, `connection_mode` sem volta pela UI). Convênios e a aba de preços do catálogo já estavam documentados pelas Tasks 7/3 |
| Atendimento manual no pipeline (`POST /conversations` + [Novo atendimento]) | api + ui | ✅ 2026-09-05 | coordenador | Porta de entrada para quem não chega pelo WhatsApp (ligação, balcão, site). Reusa `findOrCreateByPhone` — nenhuma migração, `channel` já previa `direct/web/sms`; a conversa nasce atribuída a quem cadastrou e `whatsapp` é recusado no enum (essa conversa só nasce pelo webhook). O telefone digitado é normalizado para `+55…` antes do dedupe: sem isso o paciente que já conversa pelo WhatsApp ganharia uma segunda conversa. Telefone de outro atendente → `CONVERSATION_ALREADY_ASSIGNED` (409), não 404, senão o `/budget/new` seguinte quebraria. Inventário de isolamento: 48 → **49** rotas. `NewAttendanceModal` em `/proposals` leva ao `/budget/new?conversationId=`; o card entra no pipeline quando a proposta existe. **Pendência conhecida:** "ligação" e "presencial" caem as duas em `direct` — separá-las exige coluna nova |
| `.env` da máquina vazando para os testes | api | ✅ 2026-09-03 | coordenador | Achado ao ligar `EVOLUTION_*`/`RATE_LIMIT_PER_MINUTE` no `.env` local: 3 testes de backend quebraram. Eles afirmam o comportamento **padrão** (100 req/min, gateway ausente → `CHANNEL_QR_UNAVAILABLE`) e só passavam porque o `.env` de quem rodava não tinha aquelas chaves — verde por ausência. `src/config/env.ts` não carrega mais `dotenv` em `NODE_ENV=test` |
| Pipeline: kanban de largura inteira, busca por nome e visão em lista | api + ui | ✅ 2026-09-05 | coordenador | Três queixas de uso na mesma tela. (1) O kanban rolava na horizontal e paginava de 20 em 20 — com 6 estágios, as 20 propostas da página 1 se espalhavam e o pipeline nunca aparecia inteiro; agora é `grid grid-cols-6` com `limit=100` (o teto do contrato) e sem paginação, cada coluna rolando por dentro. Acima de 100 a tela diz o total em vez de mentir. (2) `?search=` novo em `GET /proposals` (`conversations.patient_name`, `ILIKE`) — filtrar em memória só acharia quem já estivesse carregado, ou seja, buscaria dentro da página 1. O recorte por papel de D-042 continua por cima (teste explícito: atendente que busca o nome de proposta alheia recebe lista vazia). (3) `SegmentedControl` alterna Kanban/Lista com a visão na URL (`?view=lista`); a lista é uma grade dos mesmos `ProposalCard` com a `Pagination` de sempre — nenhum componente novo. Arrastar card entre colunas move o estágio com HTML5 nativo (sem biblioteca): a coluna confere `isTransitionAllowed` antes de aceitar o drop, e soltar em **Perdido** abre o modal em vez de mutar, porque a transição exige `reasonLost`. **Um bug que só o navegador revelou:** a primeira versão lia o payload do `dataTransfer` no `dragover` para decidir se aceitava o drop — mas ali o drag data store está em modo protegido (HTML5), `getData()` devolve `''`, o `preventDefault()` nunca rodava e o `drop` nem disparava; o teste em jsdom passava porque o `DataTransfer` falso era um `Map` puro, sem modo protegido. O estágio de origem passou a viajar no NOME do tipo (`types` é a única parte legível no `dragover`) e o dublê do teste agora reproduz o modo protegido. Verificado no navegador contra a API: `negociacao → ganho` gravou, `negociacao → novo_contato` não mexeu, drop em Perdido abriu o modal sem mudar o estágio. Backend 836/836, frontend 794/794, `npm run typecheck` verde nos 4 workspaces |
| Versionamento visível na UI (`v1.1.0` no rodapé do trilho) | infra + ui | ✅ 2026-09-05 | coordenador | `package.json` da raiz vira `1.1.0` (bump minor: pipeline + atendimento manual desta onda) e é a fonte única de versão — os `package.json` dos workspaces continuam em `"*"`/1.0.0, não são consumidos por ninguém. `frontend/vite.config.ts` lê esse arquivo em build-time e injeta `__APP_VERSION__` via `define` (sem chamada de rede, sem endpoint novo); `Sidebar.tsx` mostra `v1.1.0` no rodapé do trilho (só o número quando recolhido). Backend 836/836, frontend 794/794, `npm run typecheck` verde nos 4 workspaces |
| Webhook do Evolution registrado na criação da instância | api + infra | ✅ 2026-09-05 | coordenador | O bloco de QR recebia webhook (`POST /webhooks/evolution/:tenant`) mas **ninguém nunca dizia ao gateway para onde postar** — a instância pareava e nenhuma mensagem entrava. A URL de callback agora vai no próprio `/instance/create` (headers `x-evolution-webhook-token`, eventos `MESSAGES_UPSERT`/`CONNECTION_UPDATE`), com base nova `EVOLUTION_WEBHOOK_BASE_URL` (endereço do backend **visto de dentro do container do gateway**; `CORS_ORIGIN` é o do navegador e não serve). **Dois bugs que só o gateway de verdade revelou** (v2.3.7 subido no Docker, não mock): (1) `/instance/create` **não é idempotente** — o segundo POST com o mesmo nome responde `403 "already in use"`, ou seja, toda RECONEXÃO estourava; o cliente agora adota a instância existente (`/instance/fetchInstances?instanceName=` → `token`) e reaplica o webhook por `/webhook/set/:instance`; (2) `hash` do `/instance/create` vem como **string** (`"hash":"38BD…"`), não `{apikey}` — o código antigo lançava "não devolveu apikey" contra qualquer gateway real (o fake do teste usava o formato v1). Verificado ao vivo com o cliente real contra o container: create+webhook, adoção no 403, webhook persistido em `/webhook/find`, QR base64 servido. Backend 838/838, `npm run typecheck` verde nos 4 workspaces |
| Webhook Evolution: nome de evento, LID, grupo, fromMe e instância ausente | api + docs | ✅ 2026-09-05 | coordenador | Quatro bugs achados contra o gateway REAL (v2.3.7 pareado com um celular de verdade), todos invisíveis para a suíte porque os fixtures copiavam a documentação. (1) **Nome do evento:** o gateway manda `messages.upsert`/`connection.update` (minúsculo, com PONTO); o código comparava com `MESSAGES_UPSERT` — grafia que este repositório inventou. A comparação exata nunca casava, e três coisas morriam juntas e em silêncio: mensagem recebida descartada, `connection.update` nunca gravado (por isso o telefone exibido era o do seed) e a guarda de `instance` contra troca de slug virava código morto. `normalizeEvolutionEvent` aceita as duas grafias num ponto só. (2) **`remoteJid` nem sempre é telefone:** o WhatsApp passou a endereçar por LID (`128999376343081@lid`) e o número real vem em `remoteJidAlt`; `inboundPhoneOf` lê de lá, ignora `@g.us` (grupo não é paciente) e ignora `fromMe: true` (o próprio laboratório respondendo pelo celular criava atendimento novo). Sem `remoteJidAlt`, a mensagem é descartada de propósito: conversa presa a um LID não tem resposta nem dedupe. (3) **Instância ausente no gateway** (404 `does not exist`) virava **500 com corpo vazio** em `/status` e `/qr` — a tela de Canais travava sem oferecer reconexão, justo no estado em que reconectar é a única saída; agora devolve `disconnected`, e qualquer outra falha do gateway continua `CHANNEL_QR_UNAVAILABLE` (503) via `callGateway`. Documentação corrigida (`API_CONTRACTS.md` §6.1 com o payload real e a tabela de qual `key` vira atendimento, `SERVICES.md` §16, `API_ERRORS.md`). 8 testes novos usando payloads capturados do gateway; backend 849/849, typecheck verde nos 4 workspaces. **Verificado ponta a ponta na stack de produção local:** número real pareado, "Oi" enviado de outro celular chegou como atendimento |
| Validação independente | todos | ⬜ | Validador-Contratos · Validador-Segurança · Validador-Verificação | Fase 4 |

**Verificação da Fase 3, rodada pelo coordenador (não pelos autores):**

| Comando | Resultado |
|---------|-----------|
| `npm run typecheck` (4 workspaces) | verde |
| `npm run lint` | limpo |
| `npm run test:backend` | 55 arquivos · **827** testes |
| `npm run test:frontend` | 57 arquivos · **782** testes |
| `npm run e2e` (suíte completa, banco resemeado) | **112 passed**, 0 failed, 0 skip |

**Como subir o ambiente para teste manual** (o mesmo que o coordenador usou):

```
docker compose up -d postgres redis   # o gateway `evolution` é opcional (QR real)
npm run migrate && npm run seed       # credenciais impressas no fim do seed
npm run dev                           # API :3000 + UI :5173
```

Para a suíte E2E: `npm run seed:e2e` e, se o container `evolution` estiver de pé,
`docker compose stop evolution` — o fluxo 14 sobe um gateway falso na porta 8080 e
falha na subida (nunca em silêncio) se ela estiver ocupada.

---

## Onda 8 — Ferramentas de atendimento (transferência, emoji, fixar, macros, mídia) 🔄 (em andamento)

Spec: `docs/superpowers/specs/2026-09-05-onda-8-atendimento-design.md`. Entrega em 3 ondas, do
barato ao caro; cada uma commitada, testada e usável antes da seguinte.

| Tarefa | Domínio | Status | Agente | Notas |
|--------|---------|--------|--------|-------|
| §2 Onda 1 — transferência, emoji e fixar | api + db + ui + qa | ✅ 2026-09-05 | coordenador | **Transferir:** o botão virou menu com as colegas + "Devolver para a fila"; rótulo "Atribuir" enquanto a conversa está livre, e quem já é dona não aparece na lista. Endpoint novo `GET /conversations/assignees` (qualquer papel de tenant, só `id`/`name`/`role`) — sem ele o menu ficaria vazio justamente para a atendente, já que `GET /users` é admin-only; afrouxar o `/users` existente vazaria a lista de pessoal inteira. A transferência em si continua sendo `PATCH /conversations/:id`: `assertCanReassign`, mensagem de sistema e audit log já existiam e só passaram a ser alcançáveis. **Emoji:** `EmojiPicker` novo, grade fixa de 48 com `aria-label` em pt-BR, **sem dependência**; insere na posição do cursor e `Esc` devolve o foco ao campo. **Fixar:** migração `007_conversation_pins.sql` (tabela + policy no mesmo arquivo — sem backfill, nada a proteger), RLS fail-closed provada com 2 tenants; `POST`/`DELETE /conversations/:id/pin` idempotentes (204); `GET /conversations` passa a devolver `pinned` **do usuário que pediu** e ordena fixadas primeiro, sem mexer nos counts dos chips. Pin é pessoal — tabela e não coluna, senão uma atendente entupiria o topo da lista das outras. **Um achado que só o navegador revelou:** a lista tinha N botões "Fixar conversa" idênticos — ambíguo para leitor de tela e impossível de endereçar; o rótulo passou a nomear a conversa (`Fixar conversa com <paciente>`). Inventário de isolamento: 49 → **52** rotas. Backend 866/866, frontend 814/814, `npm run typecheck` verde nos 4 workspaces, `flow-15-onda8-atendimento` (3 testes) verde no Chromium contra a stack de dev |
| §3 Onda 2 — macros (respostas rápidas) | api + db + ui + qa | ✅ 2026-09-06 | coordenador | **Tela própria `/quick-replies`, `TENANT_ROLES`** — não uma aba de "Canais & Equipe", que é `MANAGER_PLUS` e barraria exatamente quem o lead quer que escreva as macros; e configurar canal é ato de administração, escrever resposta pronta é ferramenta de trabalho diária. **Schema:** migração `008_quick_replies.sql` (tabela + policy no mesmo arquivo, como a 007 — sem backfill), `UNIQUE (tenant_id, shortcut)` e `CHECK (shortcut ~ '^[a-z0-9-]{2,32}$')`; RLS fail-closed provada com 2 tenants. `created_by ON DELETE SET NULL`: a macro é do laboratório e sobrevive a quem a escreveu. **Contrato:** `GET|POST /quick-replies` + `PATCH|DELETE /quick-replies/:id`, **todos** abertos a qualquer papel de tenant — restringir a exclusão a gestor foi considerado e descartado (são textos de trabalho, versionados no audit log; travar só produziria uma lista suja que ninguém limpa). As 3 escritas geram audit log, e o `DELETE` guarda o conteúdo apagado em `oldValues` — é o que torna a exclusão reversível por uma pessoa, já que a linha não fica. Listagem **sem `pagination`**: exceção explícita ao D-070, registrada em API_CONTRACTS §9, porque a lista alimenta o menu do Composer, que precisa dela inteira para filtrar em memória. **Atalho duplicado é `VALIDATION_ERROR` com `details.fields.shortcut`, não `CONFLICT`** (divergência intencional com `/insurances`): o que a pessoa corrige é um campo do formulário, e o frontend precisa saber qual input marcar; a corrida entre o SELECT e o INSERT quem decide é o índice único, traduzido para o mesmo erro de campo em vez de um 500. **Composer:** `/` **com o campo vazio** abre o `QuickReplyMenu`, digitar filtra por atalho, ↑↓ navegam, Enter escolhe, Esc fecha deixando a `/` no campo. A restrição "campo vazio" é o que mantém "km/h", "24/48h" e URLs digitáveis. Foco nunca sai do textarea (`aria-activedescendant` sobre um `listbox`). Inventário de isolamento: 52 → **56** rotas. Backend 889/889, frontend 836/836, `npm run typecheck` verde nos 4 workspaces, `flow-16-quick-replies` (4 testes) verde no Chromium contra a stack de dev |
| §4 Onda 3 — mídia (anexo e áudio) | api + db + ui + qa | ✅ 2026-09-06 | coordenador | **Armazenamento:** volume local (`MEDIA_DIR`, env nova, obrigatória em produção como `CHANNEL_SECRET_KEY`); arquivo em disco nomeado pelo `id` da linha — nunca pelo nome que o usuário mandou (travessia de diretório). **Schema:** migração `009_message_media.sql` (tabela + policy no mesmo arquivo, sem backfill), `message_id` **nullable** de propósito — a mídia é gravada e o `attachmentUrl` calculado ANTES da mensagem existir, e só depois `message_media.message_id` é ligado à mensagem recém-criada. **Saída (`POST /conversations/:id/attachments`):** base64 em JSON, não multipart (Express 4 não faz multipart sozinho, e o Evolution já resolve mídia em base64 nos dois sentidos) — o limite de transporte do `express.json()` subiu de 1mb para 25mb para caber o teto de negócio (15 MiB de arquivo × ~1.33 do base64); o teto em si é explícito em `MediaService` (`MEDIA_TOO_LARGE`, 413), não escondido em config de middleware. **Entrada (webhook Evolution):** `message.imageMessage/audioMessage/documentMessage` reconhecidos ao lado de `conversation`/`extendedTextMessage`; arquivo acima do teto é recusado com log — a mensagem não é criada, mas o webhook responde 200 do mesmo jeito (nunca vira oráculo). **Risco aceito e registrado (spec §7.4):** o campo exato onde o gateway v2.3.7 grava o base64 da mídia recebida não foi confirmado contra um payload real — o parser tolera `message.<tipo>Message.base64` e o nível do `message`, mas só um teste contra o gateway de verdade fecha essa dúvida. **Envio de mídia pelo Evolution:** `EvolutionClient.sendMedia` (`POST /message/sendMedia/:instance`, mesma disciplina de privilégio mínimo do `sendText` — apikey da instância, nunca a administrativa). **Envio de mídia pela WhatsApp Cloud API (Meta):** não implementado nesta onda — exige upload multipart prévio, fluxo diferente do link-based do Evolution, e o ambiente de teste real do lead é QR/Evolution; lança erro claro se um tenant em `connectionMode: "cloud_api"` tentar enviar anexo. **Frontend:** o clipe do Composer deixou de ser um stub de toast — abre o seletor de arquivo do SO, lê como base64 e chama o endpoint novo. **Áudio de saída (§4.4):** condicional a provar `webm/opus` contra o gateway real — nenhuma linha de conversão entrou; ouvir áudio do paciente (entrada) já funciona e não depende disso. Inventário de isolamento: 56 → **58** rotas (`POST /conversations/:id/attachments` + `GET /media/:id`, este último com mídia própria no cenário de sonda). Backend 902/902, frontend 836/836, `npm run typecheck` verde nos 4 workspaces. **Pendente:** verificação Playwright contra a stack de dev (spec §7.4) e prova contra o gateway Evolution real (formato do base64 de entrada, `webm` na saída) — ainda não executadas nesta rodada. **Risco novo, registrado e não corrigido nesta onda:** D-075 zera `messages.attachment_url` na anonimização LGPD, mas não apaga a linha de `message_media` nem o arquivo em disco — o metadado (nome do arquivo, mimetype, tamanho) e o próprio arquivo sobrevivem ao apagamento do titular. Pedido para quem tocar `PatientRepository.anonymize` a seguir |

---

## Onda 9 — Domínio LIS no backend

Fusão CRM Lab + FluxoLab (spec `docs/superpowers/specs/2026-09-08-fusao-crm-fluxolab-design.md`,
seção "Onda 9"): domínio "Orçamentos do LIS" (importação de planilha, KPIs de Resultados/Busca
Ativa, Vendas + comissão, atendentes, Relatório executivo) e as colunas `lis_*` de `proposals`
(usadas só a partir da Onda 13). Ondas 10-13 (telas, infra/migração do Santé, cutover,
conciliação) não fazem parte deste escopo.

| Tarefa | Domínio | Status | Agente | Notas |
|--------|---------|--------|--------|-------|
| Contratos da onda (Fase 0, bloqueante) | docs | ✅ 2026-09-12 | Agent-Docs-Onda9 | `SCHEMA.md` §24-27 (`attendants`, `lis_imports`, `lis_budgets`, `sales`) + ALTER em `tenant_settings`/`insurances`/`proposals` + cobertura de RLS; `API_CONTRACTS.md` §5c (Reports), §6b (Commission Settings), §10 (LIS Budgets & Imports), §11 (Sales), §12 (Attendants) — sem `PATCH /proposals/:id/lis-reference`, que é da Onda 13; `SERVICES.md` §18-23 (`CommissionSettingsService`, `LisImportService`, `LisAnalyticsService`, `SalesService`, `AttendantService`, `ExecutiveReportService`), citando `toMoney`/`percent`/`average`/`resolvePeriod` de `analytics.service.ts`; `BUSINESS_RULES.md` §11 "Regras de deduplicação e KPIs do LIS" (dedupe por número e por requisição, convênio principal, `MIN_ORC_RANKING=20`, janelas emissão/pagamento, resolução de convênio/atendente, aliases da planilha); `DECISIONS.md` D-108→D-115 + D-118. Nenhuma linha de implementação antes disto (Regra Zero) |
| Migrações `012_lis_domain.sql` + `013_rls_lis_domain.sql` | db | ✅ 2026-09-12 | Agent-DB-Onda9 | `attendants`, `lis_imports`, `lis_budgets`, `sales` + colunas em `tenant_settings`/`insurances`/`proposals`; RLS das 4 tabelas em par de migração separado. `GENERATED … STORED` (`principal_insurance_name`, `total_value`, `attendants.folded_name`) **funciona normalmente no PGlite 0.2.17** (validado isolado antes de escrever o SQL, e depois sob RLS em `rls-onda9.spec.ts`) — **fallback do D-111 não foi necessário**, sem mudança de abordagem nem decisão nova. Testes: `backend/tests/db/rls-onda9.spec.ts` (12 testes novos) + ajuste de 1 teste pré-existente (`migration-005-006.spec.ts`, coluna `source` nova em `insurances` por D-114). `npm run typecheck` (4 workspaces) e `npm run test:backend` verdes (64 arquivos / 953 testes) |
| Rotas `/lis-imports`, `/lis-budgets`, `/sales`, `/attendants`, `/settings/commissions`, `/reports/executive` | api | ✅ 2026-09-12 | coordenador | Todas as 6 famílias de rota implementadas: `attendantModule`/`lisImportModule` (sessão anterior, já commitados) + `commissionSettingsModule`, `lisAnalyticsModule`, `salesModule`, `executiveReportModule` (esta sessão). `commissionSettingsModule` usa `basePath: '/settings/commissions'` (não `/settings` — já pertence a `channelSettingsModule`; `app.ts` recusa `basePath` duplicado). Código de erro novo `SALE_ATTENDANT_NOT_LINKED` documentado em `API_ERRORS.md`/`api.types.ts`/`errors.ts` ANTES de usado (Regra Zero). `conversionQty` de `LisAnalyticsService`/`ExecutiveReportService` capado explicitamente em `Math.min(100, percent(...))` — `percent()` de `analytics.service.ts` não capa sozinho, achado pelo teste de conversão (ver linha de QA abaixo). `npm run typecheck` verde nos 4 workspaces |
| Testes `backend/tests/lis/` + `rls-onda9.spec` + inventário de isolamento | qa | ✅ 2026-09-12 | coordenador | Feito: `commission-settings.spec.ts` (8), `sales.spec.ts` (13 — escopo por atendente, `SALE_ATTENDANT_NOT_LINKED`, DELETE escopado + isolamento multitenant, comissão), `lis-analytics.spec.ts` (6 — `MIN_ORC_RANKING`, conversão capada em 100%, dedupe por requisição, Busca Ativa, filtros), `lis-import-idempotency.spec.ts` (3 — reimportar não duplica, total menor não regride, dedupe na mesma planilha), `executive-report.spec.ts` (3 — `monthlySeries` 12 pontos, `brandName` do próprio tenant). **`LAB_ROUTES` (`route-tenant-isolation.spec.ts`) NÃO foi estendido** — decisão deliberada, não pendência: das ~19 rotas novas, só `PATCH /attendants/:id` (já coberta em `attendants.spec.ts`) e `DELETE /sales/:id` (coberta agora) são endereçáveis por `:id`; o resto (lis-budgets/sales-list/commissions/reports) é recortado por tenant via query/RLS, sem id de outro tenant para "advinhar" — estender o inventário ali duplicaria cobertura de baixo retorno. `npm run test:backend` verde: 71 arquivos / 1018 testes |

**DoD (spec):** planilha real anonimizada do Santé importa e `GET /lis-budgets/summary` bate com
o Dashboard antigo do FluxoLab no mesmo período; tenant B não vê nada.

---

## Onda 10 — Telas do LIS 🔄 (em andamento)

Telas sobre o backend do domínio LIS (Onda 9, já commitado). Spec:
`docs/superpowers/specs/2026-09-08-fusao-crm-fluxolab-design.md`. Card Jira: CRMLAB-3. Branch:
`feature/CRMLAB-3-onda-10-telas-lis`.

| Tarefa | Domínio | Status | Agente | Notas |
|--------|---------|--------|--------|-------|
| Contratos da onda (Fase 0, bloqueante) | docs | ✅ 2026-09-12 | coordenador | `PAGES.md` "Telas do LIS" (§14-19: `/results`, `/reconciliation`, `/active-search`, `/sales`, `/settings/attendants`, `/settings/commissions` + modal Importar + "Limpar base"), Mapa de Rotas e tabela de papéis atualizados; `COMPONENTS.md` seção `lis/` (`KpiCard`, `UploadDropzone`, `PeriodFilter`, `AgeBadge`); `DECISIONS.md` D-116 (PDF gerado no cliente, nunca no servidor) e D-117 (filtros de período/atendente/convênio como estado global em `useUIStore.lisFilters` + sessionStorage, compartilhado entre as 3 telas de leitura). Nenhuma linha de implementação antes disto (Regra Zero). **Correção feita durante a implementação:** `/results` (Resultados) NÃO tem seletor de atendente/convênio como o texto original previa — `GET /reports/executive` só aceita período (API_CONTRACTS §5c), e o PDF precisa ser o retrato exato do que a tela mostra (D-116); recorte por atendente/convênio já existe em Conferência/Busca Ativa, que consomem `/lis-budgets*`. PAGES.md §14 atualizado para refletir isso |
| Frontend: `api/lis.ts`, `reports.ts`, `sales.ts`, `attendants.ts`, `commission-settings.ts` + 6 páginas + componentes `lis/` + PDFs | ui | ✅ 2026-09-12 | coordenador | Implementado sozinho (não dividido em 3 agentes — ver nota abaixo). `KpiCard`/`UploadDropzone`/`PeriodFilter`/`AgeBadge`/`MonthlySeriesChart`/`ImportModal`/`PurgeDialog` em `components/lis/`; `lib/pdf/executive-report.ts` + `active-search.ts` (jspdf + jspdf-autotable, lazy import, D-116); `useUIStore.lisFilters` persistido em sessionStorage (D-117); `/settings/attendants` lê o seletor de usuário de `GET /settings/channels` (`team`, D-066) — não de `GET /users`, que é admin apenas e bloquearia o gestor. Rotas plugadas em `route-config.ts`/`routes/index.tsx` + ícones novos em `NavGlyph.tsx`. `npm run typecheck` verde nos 4 workspaces |
| Testes: component tests + `route-config.spec` | qa | ✅ 2026-09-12 | coordenador | `KpiCard`/`AgeBadge`/`PeriodFilter`.spec.tsx + specs de página para as 6 telas novas (Results/Reconciliation/ActiveSearch/Sales/Attendants/Commissions) + `routes/route-config.spec.ts` (atendente vê `/sales`, não vê as 5 telas gestor+). Suíte completa do frontend: **71 arquivos / 950 testes verdes**. Corrigido de passagem: `AgeBadge` usava `text-white` (fora do tema) e `TenantDetail.tsx` (Onda 9, não tocado por esta onda) usava `text-h4` inexistente — os dois travavam `tailwind-theme-classes.spec.ts`; trocados por tokens reais (`text-bg`/`text-section`) |
| E2E `flow-17-lis-import-results` + `flow-18-sales` | qa | ✅ 2026-09-12 | coordenador (CRMLAB-5) | Planilha `.xlsx` gerada em memória com `exceljs` (mesma lib do parser) e enviada via `setInputFiles({buffer})`, sem tocar disco. `flow-17`: importa 3 orçamentos com totais desenhados para não colidir (1800/1500/1000), confere os 4 KPIs de `/results`, "Detalhe por atendente" e reimportação idempotente (BUSINESS_RULES §11.1). `flow-18`: gestor lança venda para atendente + comissão; atendente sem vínculo recebe `SALE_ATTENDANT_NOT_LINKED`; depois de `PATCH /attendants/:id` vinculado, lança a própria venda sem seletor de atendente na tela. Achado no caminho: `getByRole('paragraph', {name})` não funciona para KPI labels — `<p>` não tem nome acessível computado; corrigido para `getByRole('paragraph').filter({hasText})` (mesmo padrão de `flow-4-analytics.spec.ts`). Suíte completa rodada 2x contra a stack real (Postgres+migrate+seed:e2e, `workers:1`): 4/4 testes novos verdes; as 17-18 falhas pré-existentes fora do domínio LIS (flow-1/2/3/8/12/13/15) foram comparadas com uma run na baseline (antes desta mudança) e batem 17/18 — não relacionadas, registradas aqui para quem for investigá-las depois, não desta tarefa |
| `/results` redesenhado a partir da referência visual real (FluxoLab/Santé) + correção de 2 bugs de cálculo (D-122 a D-125) | api+ui+db | ✅ 2026-09-12 | coordenador | Usuário reportou números divergentes da produção real ao importar a planilha; comparação linha a linha com `orcamentos-sante-main` (app de referência) achou: **(1)** `lis_budgets.total_value` (migração 012) somava `value_1+value_2+value_3` — errado, `insurance_2`/`insurance_3` são cotações ALTERNATIVAS do mesmo orçamento, não valores adicionais; corrigido pela migração `014_fix_lis_budgets_total_value.sql` (D-124) — verificado com SQL independente contra os dados reais já importados pelo usuário: **R$ 1.957.278,85 correto vs. R$ 2.096.520,68 que o bug antigo daria** (+7,1% inflado, R$ 139.241,83 de diferença, 5030 orçamentos). **(2)** "Em Requisição" tinha sido implementado com a definição de Busca Ativa (pendente de pagamento) — errado, é "convertido em requisição" (pago ou não); campo novo `requisition` em `LisBudgetsSummary`/`ExecutiveReport` (D-125), verificado do mesmo jeito (1767 requisições, R$ 611.381,12, batendo exato com SQL independente). Redesenho da tela: filtro de convênio de volta, 4 KpiCards no layout da referência (destaque + delta + barra de conversão), gráfico de atendentes (`byAttendantDetail`, sem corte de `MIN_ORC_RANKING` — D-122), donut de convênio, tabela "Detalhe por atendente" combinando orçamento+vendas com exportação em PDF e Excel (D-123, `xlsx`/SheetJS novo). Backend 72 arquivos/1026 testes, frontend 71 arquivos/968 testes, typecheck 4/4 verde |

**DoD (spec):** um gestor reproduz a rotina completa do Santé de ponta a ponta na UI local,
incluindo geração dos dois PDFs. **Atingido** — typecheck 4/4 workspaces verde, backend/frontend
com suíte de componente verde, e agora também confirmado via E2E real (Playwright + stack Docker
completa, `flow-17-lis-import-results` + `flow-18-sales`, CRMLAB-5). **Onda 10 fechada.**

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
| Agent-UI-Attendance | Agent-API | Não existe endpoint de **upload de anexo** em API_CONTRACTS.md, embora `CreateMessageRequest.attachmentUrl` exista. O botão de anexo do composer hoje só avisa o usuário. | ✅ atendido na Onda 8 §4: `POST /conversations/:id/attachments` + `GET /media/:id`, documentados em API_CONTRACTS.md §2d. O clipe do Composer abre o seletor de arquivo de verdade |
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
| Agent-API-Conversations | Agent-Kernel | `express.json()` global consome o stream antes do router do webhook, então o HMAC é calculado sobre `JSON.stringify(req.body)` (D-026). Pedido: `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })` em `createApp`. O código já prefere `req.rawBody` quando existir — é pré-requisito para ligar a API real da Meta. | ✅ atendido na Onda 7 (Task 6, C1) |
| Agent-API-Conversations | Agent-UI | `GET /conversations` agora responde `{ conversations, pagination, counts: { mine, unassigned } }` — os chips leem `counts`, e eles NÃO mudam com `?scope=`. `GET /conversations/:id` marca como lida (D-027), então o `useMarkAsRead` atual está correto; se preferir não carregar o histórico, existe `POST /conversations/:id/read` (204). Erros novos: `CONVERSATION_ALREADY_ASSIGNED` (409, com `details.assignedToName`) ao assumir/transferir e `CONVERSATION_ARCHIVED` (409) ao enviar em conversa arquivada. | ⬜ aberto |
| Agent-API-Conversations | Agent-Infra | A URL do webhook configurada no provedor precisa incluir o slug do laboratório: `POST /api/v1/webhooks/whatsapp/<slug>` (e `.../status`). `WHATSAPP_WEBHOOK_SECRET` é obrigatória para o webhook aceitar qualquer coisa — segredo vazio recusa tudo, de propósito. | ⬜ aberto |

---

## Pendências da Onda 5 — todas fechadas na Onda 6 ✅

As dez pendências abaixo foram registradas ao fim da Onda 5 e **todas foram fechadas na Onda 6**,
com teste que falharia antes da correção. Mantidas aqui como histórico do que era e de quem fechou:
D1/D4 (Agent-QA-Onda6 + Agent-UI-Cleanup), D2/D7/D9 (Agent-UI-Cleanup), D3/D5/D6/D8
(Agent-API-Fixes), D10 (as três telas — Blocos A/B/C da Onda 6).

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

## Pendências abertas ao fim da Onda 6

Achados que **não** foram corrigidos, com o motivo. Nenhum é bloqueio de funcionalidade.

| Item | Origem | Por que ficou aberto | Dono sugerido |
|------|--------|----------------------|---------------|
| ~~**HMAC calculado sobre JSON reserializado**~~ | Validador-Segurança | **Fechado na Onda 7 (Task 6, C1):** `express.json({ verify })` grava `req.rawBody`; a comparação passou a ser contra os bytes reais do corpo. Ver `tests/webhooks/rawbody-hmac.spec.ts` | Agent-Kernel |
| **Chave de cifra única por instalação, sem rotação** | D-076 | Trocar `CHANNEL_SECRET_KEY` invalida as credenciais gravadas e obriga cada laboratório a reconectar o canal. Chave por tenant exigiria guardar a chave derivada no mesmo banco, anulando o ganho contra dump. Risco aceito conscientemente | Produto + Infra |
| **Conteúdo de mensagem não é reescrito na anonimização** | D-063 (delimitada na Onda 6) | O apagamento LGPD cobre cadastro, colunas denormalizadas de `conversations`, `attachment_url` e os valores no audit log. O **texto** das mensagens permanece — reescrevê-lo destruiria o histórico de atendimento de terceiros na mesma conversa. Limitação declarada, não esquecida | Produto + jurídico |
| **Telefone fora do formato é recusado, não normalizado** | Validador-Segurança / Agent-Fix-Security | Normalizar mudaria a chave de dedupe `(tenant_id, phone)` e poderia fundir ou duplicar cadastros existentes. A perda deixou de ser silenciosa (log próprio + o resto do lote segue), mas o canal ainda não reentrega | Agent-API-Conversations |
| ~~**`page` sem teto em 3 services**~~ | Agent-Fix-Contracts | **Fechado na Onda 7 (Task 6, C2):** `MAX_PAGE = 10_000` em `conversation`, `platform`, `internal-chat` e `exam-catalog` (a lista original tinha 3; `internal-chat` também clampava até `Number.MAX_SAFE_INTEGER` e entrou na correção) | Agent-API |
| ~~**`message` em pt-BR em `POST /proposals`**~~ | Agent-Fix-Contracts | **Fechado na Onda 7 (Task 6, C7):** `message` removido de `CreateProposalResponse` (agora alias de `ProposalDetail`) e do código que o preenchia; `POST /proposals` não devolve mais nenhum texto de UI em pt-BR | Dono de `proposal.types.ts` |
| ~~**`MetricTile` variante `percent` fora do pt-BR**~~ | Agent-Fix-Evidence | **Fechado na Onda 7 (Task 10, C3):** `MetricTile.tsx` agora formata com `Intl.NumberFormat('pt-BR')` (vírgula decimal); `value` continua em pontos percentuais (não fração), então o formatador é `decimal`, não `style: 'percent'` (que dobraria a escala) | Agent-Infra7 |
| **Exames do andaime do `flow-12` ficam inativos no banco** | Agent-Fix-Budget | O produto não apaga exame (D-004: desativação é `PATCH { isActive: false }`), então a limpeza do teste desativa em vez de remover. Inerte para as telas; `/catalog` sem filtro acumula linhas entre execuções sem re-seed. É o desenho, não dívida | — |
| ~~**Comentário obsoleto em `flow-7`**~~ | Agent-Fix-Budget | **Fechado na Onda 7 (Task 10, C4):** comentário removido de `e2e/workflows/flow-7-catalog.spec.ts` | Agent-Infra7 |
| ~~**Evento WS `user.came_online` é contrato sem implementação**~~ | Agent-Docs-Arquitetura | **Fechado na Onda 7 (Task 10, C6):** removido — do tipo (`shared/types/websocket.types.ts`), do `case` órfão em `frontend/src/api/ws.ts` e da documentação (`API_CONTRACTS.md`, `ARCHITECTURE.md`). Nenhum service chegou a emiti-lo | Agent-Infra7 |
| ~~**`oldestWaitSeconds`: a ordenação da fila é contrato**~~ | Agent-Fix-Evidence | **Fechado na Onda 7 (Task 6, C5), com correção:** a premissa acima não batia com o código — `oldestWaitSeconds` nunca dependeu de ordenação; vem de `MAX(CONVERSATION_WAIT)` sobre a fila inteira (`operation.repository.ts#queueTotals`), independente de `queueItems`/`queueLimit`. `SERVICES.md §14` agora documenta esse contrato (o `MAX()`, não uma ordenação) | Agent-API + doc |

---

## Próximos passos (proposta de Onda 7 — aguardando decisão)

Esta seção é **proposta**, não compromisso. Nenhuma onda anterior deixou os próximos passos
escritos, e a falta disso apareceu na Onda 6: a pendência D7 foi registrada com nome de tela
("`/proposals` e `/catalog`") em vez de nome de comportamento, e por isso o fechamento parou nas duas
telas conhecidas e deixou a terceira (`/budget/new`) quebrada por mais uma onda.

### O que o negócio pede a seguir

`docs/integracoes/` traz a **solicitação formal de integração com o Bitlab** (o LIS do laboratório,
sistema proprietário da própria Unimed Tubarão). Ela define o CRM como a etapa *anterior* ao pedido —
da primeira mensagem do paciente até o orçamento aceito — com o Bitlab permanecendo como
sistema-mestre. A Fase 1 é **somente leitura** e resolve dois problemas nomeados no documento:

1. catálogo e preços são hoje digitados e mantidos à mão no CRM, o que gera **divergência entre o
   valor informado ao paciente e o valor real praticado**;
2. não há como confirmar se um orçamento virou requisição e foi recebido — o desfecho comercial é
   marcado à mão pela atendente, sem confronto com o que aconteceu no LIS.

### O que já está pronto para receber isso, e o que não está

| Necessidade da Fase 1 | Situação no CRM hoje |
|---|---|
| Código/mnemônico, nome, categoria, ativo/inativo | ✅ `exam_catalog` já tem |
| Preparo, prazo (TAT) | ✅ `preparation`, `turnaround_hours` |
| Preço particular | ✅ `price_private` |
| **Preços por convênio, com código TUSS/AMB** | ❌ existe um único `price_insurance`; não há convênio como entidade nem código TUSS |
| **Sinônimos do exame** | ❌ a busca casa nome e código, não sinônimo |
| **Composição de painéis / exames vinculados** | ❌ não modelado — é o que evita orçamento incompleto ou item duplicado |
| **Material/recipiente** | ❌ não modelado |
| **Origem do dado (interno × espelhado do LIS)** | ❌ não existe. Sem isso, a sincronização diária e a edição manual brigam pela mesma linha |
| **Sincronização diária + carga incremental** | ❌ existe `QueueService` (driver em memória, D-011), não um agendador |
| **Conciliação orçamento → requisição → baixa financeira** | ❌ conceito novo; hoje `ganho`/`perdido` é decisão só do CRM |

### Proposta de recorte

**Trilha A — preparar o catálogo para ser espelhado** (não depende de resposta do Bitlab)
Convênio como entidade, preço por convênio com TUSS/AMB, sinônimos, painéis, material, e a coluna de
**origem** que decide quem vence quando o LIS e a atendente discordam da mesma linha. É a mudança
estrutural mais pesada desde a Onda 1 e pode começar já, porque não depende de contrato externo.

**Trilha B — pendências que bloqueiam produção** (ver seção acima)
A mais urgente é o **HMAC sobre JSON reserializado**: ele falha fechado, então hoje ninguém percebe,
mas significa que o webhook do WhatsApp **nunca foi exercitado contra a Meta real**. Enquanto isso
não for resolvido, a integração com o canal só funciona com o driver mock. O pedido ao kernel
(`express.json({ verify })`) está aberto desde a Onda 3.

**Trilha C — conciliação comercial** (depende do Bitlab responder)
Bloco B da solicitação. Só faz sentido depois de saber o que a API do Bitlab expõe sobre requisição e
baixa financeira. **Não começar antes da resposta** — seria inventar contrato externo, exatamente o
que a Regra Zero proíbe.

### Duas perguntas em aberto para o produto

- **D-019 continua de pé:** a tabela de planos (`PLAN_CATALOG`) é provisória — preço, franquia de
  mensagens e valor do excedente foram definidos por um agente para que `GET /platform/billing`
  tivesse resposta. Ninguém confirmou com o produto, e isso vira faturamento real.
- **Hospedagem:** os dois documentos de integração têm `[PREENCHER: nuvem ou on-premise, e faixa de
  IP de saída]`. A resposta muda o `DEPLOYMENT.md` e provavelmente a decisão de rede.

---

## 2026-09-05 — Página `/decisions` + sino de notificação na Sidebar ✅

Pedido fora de onda: página dedicada só a decisões de alçada (gestor+), sem precisar abrir o Chat
Interno nem o painel de Gestão da Operação inteiro. Zero endpoint novo — reaproveita
`GET /operations/overview` (D-067) e o Modal da Proposta (§6) já existentes.

- `frontend/src/pages/Decisions.tsx` — lista `pendingDecisions`, reaproveita `PendingDecisionCard`
  (agora exportado de `pages/Settings/Operation.tsx`) e abre o Modal da Proposta ao clicar
- Rota `/decisions` (gestor+) em `routes/route-config.ts` + `routes/index.tsx`; ícone `decisions`
  em `NavGlyph`
- Sino funcional: `Badge` no item "Decisões" da Sidebar com `pendingDecisions.total` — mesma query
  (`queryKeys.operationOverview`), cache compartilhado, sem chamada extra
- `approval.requested` e `approval.decided` (`api/ws.ts`) agora também invalidam
  `queryScopes.operations`, então o contador cai ao vivo quando alguém decide, sem esperar o
  refetch de 60s
- Doc: `docs/frontend/PAGES.md` §12 (nova) e `docs/frontend/COMPONENTS.md` (Sidebar)
- `npm run typecheck` e `npm run test:frontend` verdes (798 testes)

## 2026-09-09 — Mensagens diretas (DM) no Chat Interno — lista de usuários estilo Teams ✅

Pedido fora de onda: mostrar quem dá para chamar no Chat Interno e abrir uma conversa 1:1 por
texto (sem áudio/vídeo, confirmado com o usuário). D-101.

- Migração `010_internal_chat_dm.sql`: `internal_channels` ganha `dm_user_a_id`/`dm_user_b_id`
  (par ordenado, `CHECK dm_user_a_id < dm_user_b_id`) + 2 índices. Sem GRANT/policy novos (RLS já
  cobre a tabela)
- `GET /internal-chat/users` (diretório, exclui o próprio usuário e inativos) e
  `POST /internal-chat/dms` (get-or-create idempotente, 200) — `internal-chat.repository.ts`
  (`listDirectoryUsers`, `findActiveUserById`, `getOrCreateDirectChannel`, filtro de visibilidade
  por participante em `SELECT_CHANNEL_FOR_USER`) + `internal-chat.service.ts`
  (`listDirectory`, `getOrCreateDirectChannel`) + rotas em `internal-chat.routes.ts`
- **Correção de segurança:** `findChannelById` (usado por `listMessages`/`send`/`markChannelRead`)
  não filtrava DM por participante — corrigido junto, verificado ao vivo (gestor não-participante
  → `404 NOT_FOUND` ao tentar ler/escrever numa DM alheia do mesmo tenant)
- `Channel.otherUserId`/`otherUserName` (novos, só em `kind: "dm"`) — o `name` gravado na linha da
  DM é interno, nunca exibido
- Frontend, 1ª versão: `UserDirectory.tsx` — seção "Usuários" sempre visível, abaixo de
  Canais/Mensagens diretas. **Revisado no mesmo dia** por feedback (ocupava espaço demais junto
  dos canais): virou `UserSearch.tsx` — campo de busca (`SearchInput`, debounce 300ms, filtro em
  memória sobre o diretório já carregado) no TOPO da barra lateral, resultados só aparecem
  enquanto digita e somem ao escolher um nome; a barra lateral voltou a ter só Canais/Mensagens
  diretas. `ChannelList.tsx` usa `otherUserName` para exibir o nome da DM; `index.tsx` com
  `useMutation` de `startDirectChannel` selecionando o canal devolvido
- Doc: `API_CONTRACTS.md` §3b, `SCHEMA.md` §11, `SERVICES.md` §7, `WORKFLOWS.md` §6,
  `PAGES.md` §9 (atualizado de novo após a revisão de UX), `DECISIONS.md` D-101
- Verificado ao vivo (`docker compose up -d` + `npm run dev`): diretório exclui o próprio usuário,
  DM idempotente (mesmo `id` nas duas chamadas), `otherUserName` correto dos dois lados, DM some
  da lista de quem não participa
- `npm run typecheck` (4 workspaces), `npm run test:backend` e `npm run test:frontend` (59
  arquivos / 843 testes) verdes

## 2026-09-09 — Console da Plataforma: detalhe por tenant, status de canal e ações administrativas ✅

Pedido fora de onda: o produto vai ser vendido a múltiplos laboratórios no mercado, e quem opera
a plataforma comercialmente precisa gerenciar as empresas clientes — ver se a integração de
WhatsApp está de pé, suspender/reativar, trocar plano, resetar acesso de um admin. D-102.

- Exceção mínima e nomeada ao invariante "console não vê dado de laboratório"
  (`platform.service.ts`, `platform.repository.ts`): status de canal (`tenant_channels.channel`/
  `is_active`/`connection_mode`/`connected_at` — nunca telefone/token) e e-mail de usuário
  `role: 'admin'` (nunca nome, nunca `manager`/`attendant`)
- `GET /platform/tenants/:id` (`TenantDetail`: `channels[]` + `admins[]` + `usage` agregada —
  usuários ativos/total, último login, propostas e mensagens do mês), `PATCH /platform/tenants/:id`
  (suspende/reativa e/ou troca plano, diff-then-audit) e
  `POST /platform/tenants/:id/users/:userId/reset-password` (senha temporária em texto plano só
  na resposta, uma vez, nunca logada; só aceita `userId` `admin` do próprio tenant —
  `NOT_FOUND` em qualquer outro caso) — `platform.repository.ts` (`tenantChannels`, `tenantAdmins`,
  `tenantUsageHealth`, `findTenantUser`, `setUserPassword`, `updateTenant`) +
  `platform.service.ts` (`getTenantDetail`, `updateTenant`, `resetAdminPassword`) +
  `platform.routes.ts`
- Frontend: `pages/Platform/TenantDetail.tsx` (drill-down em `/platform/tenants/:id`, chegada por
  clique na linha de `Tenants.tsx` — não é item de sidebar) — integrações, saúde de uso,
  suspender/reativar com confirmação, trocar plano, resetar senha (com escolha de admin quando há
  mais de um) e modal de senha temporária com aviso de exibição única
- **Correção de pré-existente, descoberta ao rodar a suíte completa:** `GET /internal-chat/users` e
  `POST /internal-chat/dms` (D-101) nunca tinham entrado no inventário `LAB_ROUTES` de
  `tests/kernel/route-tenant-isolation.spec.ts` — corrigido junto (58 → 60 rotas)
- Doc: `DECISIONS.md` D-102, `architecture/SECURITY.md` "Console de Plataforma",
  `api/API_CONTRACTS.md` §5b, `frontend/PAGES.md` §11.1
- `npm run typecheck` (4 workspaces), `npm run test:backend` (63 arquivos / 937 testes) e
  `npm run test:frontend` verdes

## 2026-09-09 — Propostas: numeração sequencial + fluxo "Enviar orçamento" ✅

Pedido do usuário: 1) corrigir a tela de `/budget/new` (catálogo sem rolagem própria, barra
lateral crescendo com a página, botão "Criar Orçamento" enterrado no fim de uma página gigante)
e a navegação pós-criação (o botão não levava a lugar nenhum); 2) depois de criar, o orçamento
precisava de número sequencial rastreável e um botão "Enviar orçamento" que abrisse o atendimento
do paciente com uma mensagem pronta.

- **Layout de `/budget/new`:** `BudgetLayout.tsx` usava `min-h-screen` (altura MÍNIMA, sem teto)
  no container das duas colunas — sem um teto, `overflow-y-auto` de catálogo e resumo nunca tinha
  o que rolar por dentro: a página inteira crescia para caber tudo, e o botão do resumo ficava lá
  embaixo dela. Trocado para `h-screen` (mesmo padrão já usado no `Sidebar`) — catálogo e barra
  lateral agora rolam cada um por dentro, do tamanho certo da tela.
- **Navegação pós-criação:** `useCreateProposal` só invalidava cache, não navegava a lugar nenhum.
  `SummaryColumn.handleCreateProposal` agora, ao criar com sucesso, volta para `/proposals` com o
  modal da proposta recém-criada aberto (mesmo mecanismo do drag-and-drop do Kanban).
- **`proposalNumber` (D-103):** sequencial **por
  tenant** (não global), migração `011_proposal_number.sql` (coluna + backfill via `ROW_NUMBER()`
  + índice único `(tenant_id, proposal_number)`). Gerado em
  `ProposalRepository.insertProposal` via `pg_advisory_xact_lock(hashtext(tenant_id))` +
  `MAX(proposal_number) + 1` na MESMA transação do `INSERT` — sem tabela de contador dedicada.
  Exposto em `Proposal.proposalNumber` (`API_CONTRACTS.md` §3), formatado na UI como `#000123`
  (`formatProposalNumber`, `@crm-lab/shared`). Seeds (`dev.ts`, `e2e.ts`, factory de teste
  `createProposal`) numeram por tenant também.
- **"Enviar orçamento" (D-104)** (`ActionsRow.tsx`, só visível em `novo_contato`): avança o estágio para
  `orcamento_enviado` E navega para `/attendance?conversationId=…&draft=…` com a mensagem
  `"Olá! Segue o orçamento nº #000123, no valor de R$ 179,80."` pré-preenchida no `Composer`
  (`Composer.initialValue`, novo prop) — a pessoa ainda revisa e aperta "Enviar" ali, nada sai
  sozinho. `Attendance/index.tsx` lê `conversationId`/`draft` da URL só no mount.
- Doc: `api/API_CONTRACTS.md` §3 (`proposalNumber` nos 3 shapes de resposta),
  `database/SCHEMA.md` (coluna nova em `proposals`).
- `npm run typecheck` (4 workspaces) verde. `npm run test:backend` verde (63 arquivos / 937
  testes). `npm run test:frontend`: verde exceto 2 falhas **não relacionadas** a esta mudança —
  `tailwind-theme-classes.spec.ts` (pré-existente, `text-h4` em `Platform/TenantDetail.tsx`, fora
  desta tarefa) e `CatalogSegments.spec.tsx` (timeout de 5s só no full-run; passa isolado —
  flakiness de timing, não regressão).
- Verificado ao vivo: `npm run migrate` aplicado no Postgres local, backfill conferido via
  `psql` (numeração sequencial correta por tenant), backend (`tsx --watch`) recarregou sem erro.

## 2026-09-09 — Pipeline: voltar um estágio + "Avançar para X" ✅

Sequência do pedido anterior (numeração + "Enviar orçamento"): usuário testou ao vivo e pediu 2
ajustes na máquina de estados do pipeline.

- **Bug corrigido no caminho:** o botão "Enviar orçamento" (D-104) deixava a tela em branco ao
  abrir qualquer card — `GlobalModals`/`ProposalModal` estava fora do `<RouterProvider>` em
  `App.tsx` (irmão dele, não descendente), então `useNavigate()` derrubava a árvore inteira sem
  contexto de rota. Movido para dentro de `AppShell.tsx` (elemento de ROTA, já dentro do router).
- **D-105:** `ALLOWED_TRANSITIONS` ganha 3 arestas de volta (`orcamento_enviado → novo_contato`,
  `follow_up → orcamento_enviado`, `negociacao → follow_up`) — `ganho`/`perdido` continuam
  terminais, sem reabertura. Botão novo "Avançar para X" (`NEXT_STAGE`,
  `orcamento_enviado → follow_up → negociacao`) soma ao seletor "Mudar estágio" já existente, que
  também ganhou as transições de volta de graça (lê da mesma constante).
- Doc: `BUSINESS_RULES.md` §3, `WORKFLOWS.md` §4, `DECISIONS.md` D-105.
- `npm run typecheck` (shared/backend/frontend) verde. Backend: 229 testes relevantes
  (`tests/proposals`, `tests/patients/patients-timeline.spec.ts`,
  `tests/kernel/route-tenant-isolation.spec.ts`) verdes. Frontend: `Proposals.spec.tsx` (12) +
  `ProposalModal.spec.tsx` (6) verdes.

## 2026-09-09 — Busca de Pacientes: tela nova `/patients` ✅

Pedido do usuário: uma tela para procurar a ficha de um paciente por nome, CPF ou telefone sem
depender do inbox. Não existia — só `/patients/:id` (ficha) e o bloco de busca `limit=5` dentro
do Atendimento.

- **Nenhum endpoint novo.** `GET /patients` já casa nome, telefone e documento em OR dentro de um
  único `?search=` (API_CONTRACTS.md §2c, D-060) — é o mesmo que o bloco "Pacientes" do inbox usa.
  Um campo de busca só já cobre "procurar por nome, CPF ou telefone"; três caixas separadas
  exigiriam filtro AND por campo que o contrato não tem, então a tela usa `SearchInput` único.
- `frontend/src/pages/Patients/List.tsx` (`PatientsList`): `PageContainer` + `PageHeader` +
  `SearchInput` + `DataTable` (Nome, Telefone, CPF formatado, Última interação) + `Pagination` —
  todos componentes já existentes, mesmo padrão de `Platform/Tenants.tsx`. Linha clicável leva a
  `/patients/:id`.
- Rota `/patients` (attendant · manager · admin) registrada em `route-config.ts` — aparece no
  trilho da Sidebar com ícone novo (`patients` em `NavGlyph.tsx`); guard e trilho já vêm de graça
  por serem data-driven a partir dali.
- Doc: `PAGES.md` §2a (nova) + linha em "Mapa de Rotas" e na tabela de papéis.
- `npm run typecheck` verde nos 4 workspaces. Frontend: `Patients/List.spec.tsx` (5 testes novos)
  + `Patients/Profile.spec.tsx` (19) verdes, suíte completa 858 testes (1 falha pré-existente e
  não relacionada em `tailwind-theme-classes.spec.ts`, de `Platform/TenantDetail.tsx:185`).

## 2026-09-09 — Telefone editável na Ficha do Paciente + botão "Enviar mensagem" ✅

Pedido do usuário: corrigir telefone errado no cadastro (reverte D-061) e abrir o Atendimento
direto da ficha, com o contato já carregado.

- **`phone` editável (D-106).** `PATCH /patients/:id` aceita `phone` (nunca `null` — apagaria a
  chave de dedupe do webhook), normaliza para o mesmo E.164 que o webhook grava e recusa com
  `409 CONFLICT`/`phone_already_in_use` quando o número já pertence a outro paciente do tenant —
  nunca funde os dois cadastros. `PatientRepository` ganha `isUniqueViolation` (mesmo padrão de
  `exam.repository.ts`/`insurance.repository.ts`). `PatientProfileForm.tsx`: campo deixa de ser
  `readOnly`, mostra erro de campo no conflito.
- **Botão "Enviar mensagem" (D-107)** no cabeçalho da ficha: chama `POST /conversations`
  (mesmo `findOrCreateByPhone` de "Enviar orçamento", nenhum endpoint novo) e navega para
  `/attendance?conversationId=<id>`. `409 CONVERSATION_ALREADY_ASSIGNED` vira toast com o nome de
  quem está atendendo, sem navegar.
- Docs: `DECISIONS.md` D-106/D-107, `API_CONTRACTS.md` §2c (PATCH /patients/:id e a nota de
  "Não existe POST /patients"), `PAGES.md` §3.
- `npm run typecheck` verde nos 4 workspaces. Backend: suíte completa verde, incluindo os 2 testes
  novos de `patients.routes.spec.ts` (edição + conflito de telefone). Frontend: `Profile.spec.tsx`
  (20, com os 2 novos de telefone) verdes; suíte completa 864 testes, mesma 1 falha pré-existente
  e não relacionada de `tailwind-theme-classes.spec.ts` (`Platform/TenantDetail.tsx:185`).

## 2026-09-12 — Agrupamento do menu em categorias (CRMLAB-4) ✅

Pedido do usuário: menu com 21 itens soltos dificultava a navegação; agrupar em categorias.
Escopo e decisões de UX (ordem dos grupos, estado inicial do accordion, comportamento de grupo
vazio) fechados com o usuário no card CRMLAB-4 antes de codar.

- **D-127.** `route-config.ts`: campo `group?: NavGroupId` por rota + `NAV_GROUPS` (ordem fixa) +
  `sidebarSectionsFor(role)` (soltos + grupos, omitindo grupo vazio para o papel). `sidebarRoutesFor`
  (usado pelo guard de rota) não muda.
- **Sidebar.tsx** renderiza itens soltos primeiro, depois cada grupo como accordion (aberto por
  padrão); item extraído para `SidebarNavItem` para reuso entre soltos e agrupados.
- **Nova store `sidebar-groups.store.ts`**: estado aberto/fechado por grupo, persistido em
  localStorage por usuário (`crm-lab.sidebar-groups`) — preferência duradoura, ao contrário do
  recolher/expandir do trilho inteiro (`ui.store`, não persistido).
- Docs: `DECISIONS.md` D-127, `PAGES.md` (tabela de papéis por rota + coluna "Grupo"),
  `COMPONENTS.md` (`Sidebar`).
- Verificado visualmente com Playwright (login real, seed de dev): grupos aparecem na ordem
  combinada, accordion abre/fecha ao clicar no cabeçalho, grupo vazio some para o perfil,
  badge de "Decisões" continua funcionando dentro do grupo Comercial.
- `npm run typecheck` verde nos 4 workspaces. Frontend: suíte completa 981 testes verdes
  (13 novos: `route-config.spec.ts` +5, `Sidebar.spec.tsx` +4, `sidebar-groups.store.spec.ts` +4).

## 2026-09-12 — Sidebar "Trilho de grupo": revisão visual pós-rejeição (CRMLAB-4) ✅

Usuário validou visualmente o resultado de D-127 (cabeçalho de grupo maior, `font-heading
text-section`) e não aprovou. Trouxe uma especificação nova ("Trilho de grupo", Claude Design) com
paleta/fonte próprias (hex + DM Sans) — **não adotadas literalmente** (quebrariam D-005, tema por
tenant, e a regra "zero hex/zero nome de fonte em componente"); estrutura e comportamento do spec
foram traduzidos para os tokens já existentes.

- **D-128** (supersede parcial de D-127 — agrupamento/ordem continuam iguais, só o visual muda):
  272px/64px (era 244/72); cabeçalho de grupo agora do mesmo tamanho do item (`font-body
  text-label font-bold`); um único divisor entre soltos e grupos; filhos indentados atrás de um
  trilho (`border-l-2`); item ativo com `accent-500` sólido + `text-bg` (era `accent-200` +
  `shadow-sm`); chevron `▶` rotativo; ponto de destaque no cabeçalho quando o grupo tem filho ativo
  e está fechado; foco de teclado com `outline` visível; scrollbar fina na lista.
- Escopo do spec original deixado de fora (registrado em D-128): flyout dos grupos no recolhido e
  marcador de ponto/quadrado nos itens (já cobertos pelo `NavGlyph` existente).
- Docs: `DECISIONS.md` (D-128), `COMPONENTS.md` (`Sidebar`), `DESIGN_TOKENS.md` (largura).
- Verificado visualmente com Playwright (login real, seed de dev): grupo aberto com item ativo,
  grupo fechado mostrando o ponto de destaque, e trilho recolhido (64px).
- `npm run typecheck` verde nos 4 workspaces. Frontend: suíte completa 981 testes verdes
  (`Sidebar.spec.tsx` atualizado para as novas larguras/classes, nenhum teste novo — mesmo
  comportamento coberto, visual diferente).

## 2026-09-12 — Reagrupamento do menu: "Gestão" funde Comercial + LIS; Catálogo vira Cadastro de Exames (CRMLAB-4) ✅

Usuário aprovou D-128 (visual "Trilho de grupo") e pediu mais um ajuste antes de fechar o card: os
grupos "Comercial" e "LIS / Operação Laboratorial" pareciam redundantes; e "Catálogo" fazia mais
sentido em Configurações.

- **D-129.** `route-config.ts`: `NavGroupId` perde `'comercial'`/`'lis'`, ganha `'gestao'`.
  `NAV_GROUPS` = Comunicação → Gestão → Configurações. Grupo "Gestão": Conversão, Decisões,
  Resultados, Conferência, Busca Ativa, Gestão da Operação. `/catalog` sai do grupo e vai para
  Configurações, rótulo "Catálogo" → "Cadastro de Exames" (já era o `<h1>` da própria página).
- Nenhuma mudança em `Sidebar.tsx` (D-128 continua valendo) nem em rota/papel/contrato de API — só
  a organização dos grupos em `route-config.ts`.
- Docs: `DECISIONS.md` (D-129), `PAGES.md` (tabela de rotas/grupo), `COMPONENTS.md` (ordem dos
  grupos).
- `npm run typecheck` verde nos 4 workspaces. Frontend: suíte completa 982 testes verdes
  (`route-config.spec.ts` e `Sidebar.spec.tsx` atualizados para os novos grupos/rótulo — 1 teste
  novo cobrindo o grupo Configurações completo).

## 2026-09-13 — Cadastro de pacotes de exames (combos) — nova aba em Cadastro de Exames (CRMLAB-10) ✅

Pedido do usuário: hoje só existe cadastro de exames individuais; pacotes/combos de exames
(ex.: check-ups) precisam de cadastro próprio dentro da mesma tela de Cadastro de Exames.
Escopo fechado com o usuário: preço sempre derivado (soma dos exames menos desconto%), nunca
digitado; mesma alçada/convenção ativo-inativo do catálogo; e o pacote pode ser adicionado a um
orçamento novo, expandindo em uma linha por exame.

- **D-130.** Backend: `exam_packages`/`exam_package_items`/`exam_package_prices` (migrações
  `015_exam_packages.sql` + `016_rls_exam_packages.sql`, SCHEMA.md §28-30), `ExamPackageService`
  (`calculatePackagePrivatePrice` em `@crm-lab/shared`, mesma função no back e no front),
  `GET/POST/PATCH /exam-packages` + `GET/PUT /exam-packages/:id/prices` (API_CONTRACTS.md §4b).
- Frontend: nova aba "Pacotes" em `/catalog` (`PackageTable` + `PackageModal` +
  `PackagePricesTab`, ao lado da aba "Exames"). Segmento "Pacotes" de `/budget/new`
  (`CatalogSegments`) passa a listar pacotes de verdade e expandir em N linhas no resumo ao
  clicar (`BudgetNew.handleAddPackage`).
- **Corrigido de passagem (fazia parte do bug CRMLAB-13):** os segmentos "Pedido Médico"/"IA"/
  "Pacotes" de `CatalogSegments` caíam por engano no conteúdo do Catálogo (a renderização não
  olhava para `segment`) — agora "Pedido Médico"/"IA" mostram um placeholder honesto ("ainda não
  disponível"), CRMLAB-13 continua aberto só para esses dois.
- **Bug de `setState` não-funcional corrigido em `Budget/New.tsx`:** `handleAddItem` usava
  `items.find`/`setItems(items.map(...))` fechado sobre o `items` da última renderização — expandir
  um pacote chama `handleAddItem` N vezes no mesmo evento, e todas as chamadas viam o MESMO
  `items` desatualizado (só o ÚLTIMO exame sobrevivia). Corrigido para `setItems(current => ...)`
  (updater funcional). Coberto por teste de regressão em `New.spec.tsx`.
- **Limitação conhecida, registrada (não é bug):** o seletor de exames do `PackageModal` não
  garante que um exame já incluído no pacote apareça no checkbox se ele não bater com a busca
  atual (ou estiver além do 100º exame) — o exame não se perde (`examIds` preserva o id), só
  fica invisível até uma busca que o traga de volta. Ver PAGES.md §7.
- Docs: `DECISIONS.md` D-130, `API_CONTRACTS.md` §4b, `SCHEMA.md` §28-30, `PAGES.md` §4/§7.
- `npm run typecheck` verde nos 4 workspaces. Backend: `exam-package-routes.spec.ts` (14) +
  `exam-package-service.spec.ts` (10) verdes, suíte completa verde (1052 testes). Frontend: suíte
  completa 1011 testes verdes (29 novos: `PackageModal.spec.tsx` 9, `PackagePricesTab.spec.tsx`
  4, `Catalog.spec.tsx` +3, `CatalogSegments.spec.tsx` ajustado, `New.spec.tsx` +1).
- **Observação de merge:** desenvolvido em paralelo com CRMLAB-9 (worktrees/branches
  independentes) — as duas usaram o índice de migração `015_*`; esta ocupa `015`/`016`, CRMLAB-9
  foi renumerado para `017_*` na integração.

## 2026-09-13 — Campo "Médico solicitante" nas propostas/orçamentos (CRMLAB-9) ✅

Pedido do usuário: rastrear qual médico solicitou o exame/procedimento diretamente na
proposta/orçamento. Escopo fechado com o usuário: texto livre, opcional, sem cadastro de
médicos, aparece no PDF só se preenchido (hoje não existe PDF de proposta — ver nota abaixo),
sem migração de dados retroativa.

- **D-131.** `requestingDoctor` novo em `proposals` (migração
  `017_proposal_requesting_doctor.sql`, nullable). `POST /proposals` aceita o campo (opcional,
  máx 255, `trim` — vazio vira `NULL`); imutável depois de criado, sem rota de `PATCH`.
  Exposto em `Proposal`/`ProposalDetail`.
- Frontend: `Input` "Médico solicitante (opcional)" em `SummaryColumn.tsx` (`/budget/new`);
  `ProposalModal.tsx` mostra a linha só quando `requestingDoctor` não é `null`.
- Nota registrada no doc (não é pendência aberta): não existe geração de PDF de proposta
  individual hoje (só Relatório Executivo/Comissão/Busca Ativa, client-side) — quando existir,
  lê o campo do detalhe como qualquer outro.
- Docs: `DECISIONS.md` (D-131), `API_CONTRACTS.md` §3, `SCHEMA.md` (coluna nova),
  `BUSINESS_RULES.md` (tabela de campos opcionais), `PAGES.md` (`/budget/new` e modal de
  proposta).
- `npm run typecheck` verde nos 4 workspaces. Backend: suíte completa 1030 testes verdes
  (`proposal-routes.spec.ts` com os novos casos de `requestingDoctor`). Frontend: suíte
  completa 986 testes verdes (`ProposalModal.spec.tsx` + `Budget/New.spec.tsx` com os casos
  novos).
- Desenvolvido em paralelo com CRMLAB-10 (worktrees/branches independentes) — mesmo índice de
  migração `015_*` usado nas duas branches; renumerada para `017_proposal_requesting_doctor.sql`
  na integração (CRMLAB-10 ocupa `015`/`016`).

## 2026-09-13 — v1.5.0: CRMLAB-9 + CRMLAB-10 mergeados, tag para homologação

Bump minor (1.4.0 → 1.5.0, `package.json` raiz — fonte única de versão, lida em build-time pelo
frontend via `__APP_VERSION__` e mostrada no rodapé do trilho, COMPONENTS.md): duas features
aditivas mergeadas em `main` (PR #4 CRMLAB-9, PR #5 CRMLAB-10), nenhuma mudança que quebre
contrato existente.

- Tag `v1.5.0` criada e enviada para o `main` pós-merge.
- `npm run typecheck` verde nos 4 workspaces no `main` pós-merge.

## 2026-09-16 — Badge de não lidas do Chat Interno no menu lateral (CRMLAB-8) ✅

Usuário reportou que mensagem em conversa/grupo recolhido passava despercebida. Investigação
mostrou que o chat interno não tem hierarquia de grupos de conversa própria — o único "grupo
recolhível" do produto é o grupo de menu "Comunicação" (D-127/D-128); ambiguidade resolvida com o
usuário durante o dev (fluxo `duvida` do CRMLAB) antes de codar.

- **D-132.** `Sidebar.tsx` soma `Channel.unreadCount` de `GET /internal-chat/channels` (mesma
  query/cache de `InternalChat/index.tsx`, sem endpoint novo) e mostra um `Badge` no item "Chat
  Interno" (mesmo padrão do badge de "Decisões"). Grupo "Comunicação" fechado com total > 0: o
  mesmo `Badge` aparece no cabeçalho do grupo, no lugar do ponto de "item ativo dentro" (D-128).
  Sem som, sem notificação push do navegador.
- Docs: `DECISIONS.md` (D-132), `PAGES.md` (§9 — novo bloco "Badge de não lidas no menu lateral"),
  `COMPONENTS.md` (`Sidebar`).
- `npm run typecheck` verde nos 4 workspaces. Frontend: `Sidebar.spec.tsx` verde (19 testes,
  incluindo os 3 casos novos: soma do badge no item, badge substituindo o ponto no grupo
  fechado, badge ausente com zero não lidas).
- Validado e aprovado pelo usuário em 2026-09-16.

## 2026-09-16 — Inativar/reativar paciente (CRMLAB-11) ✅

Pedido do usuário: hoje não há como marcar um paciente como inativo no CRM. Escopo fechado em
discussão: qualquer usuário pode inativar/reativar (sem alçada especial), motivo obrigatório nas
duas pontas, dados vinculados (orçamentos, conversas) permanecem intactos — só passam a
referenciar o paciente como inativo —, paciente inativo some das listagens por padrão com
checkbox de filtro para voltar a aparecer.

- **D-133.** `patients` ganha `inactivated_at`/`inactivation_reason` (migração
  `018_patient_inactivation.sql`, mesmo desenho de `anonymized_at`/D-063 — sem tabela de
  histórico, sem `DELETE`). `POST /patients/:id/inactivate` e `.../reactivate` novos,
  **qualquer papel de laboratório** (ao contrário do bloco LGPD, que é admin-only). Motivo vai
  só para o audit log (`inactivate_patient`/`reactivate_patient`); reativar zera os dois campos
  na linha. `GET /patients` ganha `?includeInactive=true` (default esconde inativo). Paciente
  anonimizado não pode ser inativado/reativado (409, mesmo princípio do `PATCH`).
- Frontend: `PatientInactivationSection.tsx` (novo componente, visível a qualquer papel —
  diferente de `PatientLgpdSection`) integrado em `Profile.tsx` (chip "Inativo" no cabeçalho);
  `List.tsx` ganha checkbox "Mostrar inativos" e coluna de status.
- Docs: `DECISIONS.md` (D-133), `API_CONTRACTS.md` §2c (dois endpoints novos, campos em
  `Patient`), `SCHEMA.md` §14 (colunas novas), `SERVICES.md` §12 (`inactivate`/`reactivate`),
  `PAGES.md` §2a/§3.
- `npm run typecheck` verde nos 4 workspaces. Backend: suíte completa verde (1072 testes,
  incluindo o inventário de rotas corrigido com `POST /patients/:id/inactivate|reactivate` e o
  spec novo `patients-inactivation.spec.ts`). Frontend: suíte completa verde (1026 testes,
  incluindo os casos novos em `Profile.spec.tsx`/`List.spec.tsx`).
- Validado e aprovado pelo usuário em 2026-09-16.

## 2026-09-16 — Editar itens/desconto/médico solicitante de uma proposta (CRMLAB-12) ✅

Pedido do usuário: poder ver e editar um orçamento já criado. Escopo fechado com o usuário no
Jira antes da implementação: convênio fica de fora (continua imutável); itens, desconto e
médico solicitante passam a ser editáveis; edição de itens que estoura a alçada do desconto
reabre a aprovação (`pending`) em vez de bloquear.

- **D-134.** Novo `PATCH /proposals/:id/items` substitui a lista de itens inteira e,
  opcionalmente, `discountPercent`/`requestingDoctor` — só aceito em
  `novo_contato`/`orcamento_enviado` (`EDITABLE_STATUSES`/`isProposalEditable` em
  `shared/types/proposal.types.ts`), `PROPOSAL_EDIT_NOT_ALLOWED` (409) fora disso. Preços sempre
  resolvidos pelo catálogo (D-003); alçada de desconto reaproveita a regra de
  `PATCH /discount` (D-045). Evento WS novo: `proposal.updated`.
- Backend: `proposal.service.ts` (`updateItems`), `proposal.routes.ts`, `proposal.repository.ts`
  (`deleteItems`, `requestingDoctor` em `ProposalPatch`), `errors.ts`
  (`PROPOSAL_EDIT_NOT_ALLOWED`).
- Frontend: `ProposalModal.tsx` ganha modo de edição (botão "Editar" some fora dos estágios
  editáveis); `DiscountSection.tsx` deixa de ficar com `readOnly`/`onChange` hardcoded fora do
  modo de edição; novo `EditableItemsList.tsx` (adicionar/remover exame, mudar quantidade).
- Docs: `DECISIONS.md` (D-134), `API_CONTRACTS.md` §3 (novo endpoint + notas de
  imutabilidade atualizadas), `API_ERRORS.md`, `FRONTEND_BACKEND.md` (evento WS), `PAGES.md`
  §6 (modal).
- `npm run typecheck` verde nos 4 workspaces. Backend: suíte completa verde
  (`proposal-routes.spec.ts` com os novos casos de `/items`; `route-tenant-isolation.spec.ts`
  atualizado para 63 rotas, somando CRMLAB-11 + CRMLAB-12). Frontend: suíte completa 1019 testes
  verdes (1 falha de timing em `CatalogSegments.spec.tsx` não relacionada — passa isolado).
- **Nota de arquitetura para quem tocar `ProposalService` depois:** `db.withTenant` não
  aninha — a resolução de preço no catálogo (`examCatalog.resolveActiveByIds`, outro service)
  precisa ficar FORA do bloco de transação de escrita, exatamente como em `create`. Uma
  primeira versão deste método chamou o catálogo DENTRO do `withTenant` e deadlockou a suíte de
  testes (conexão única do driver PGlite) — corrigido antes do merge.
- Validado e aprovado pelo usuário no ambiente local em 2026-09-16.

## 2026-09-16 — v1.6.0: CRMLAB-8 + CRMLAB-11 + CRMLAB-12 mergeados, tag criada

Bump minor (1.5.0 → 1.6.0, `package.json` raiz): três features aditivas mergeadas em `main`
(PR #8 CRMLAB-8, PR #6 CRMLAB-11, PR #7 CRMLAB-12), nenhuma mudança que quebre contrato
existente.

- Tag `v1.6.0` criada e enviada para o `main` pós-merge.
- `npm run typecheck` verde nos 4 workspaces no `main` pós-merge.

## 2026-09-17 — CRMLAB-15 + CRMLAB-16: imagem inline e fechar conversa (padrão WhatsApp Web)

Escopo discutido e fechado com o usuário antes de codar: anexo de imagem passa a abrir na própria
tela de atendimento; conversa aberta ganha um botão de fechar que limpa a seleção, mantendo lista
+ conversa lado a lado no desktop (sem colapso/responsividade — fora de escopo).

- Frontend: novo `components/shared/ImageLightbox.tsx` (visualização full-screen, mais leve que
  `Modal`, reaproveita os tokens `bg-backdrop`/`rounded-lg`/`shadow-lg`/`rounded-pill`).
  `MessageBubble.tsx` renderiza thumbnail para `messageType: 'image'` e abre o lightbox ao clicar
  (estado local do componente). `ConversationPanel.tsx` ganha botão [× Fechar] no header
  (`onClose`), ligado a `setSelectedId(null)` em `pages/Attendance/index.tsx`. O estado vazio
  "Selecione uma conversa" já existia (`EmptyState` dentro do próprio `ConversationPanel`) — nada
  novo precisou ser criado aí.
- Docs: `COMPONENTS.md` (`MessageBubble`, novo `ImageLightbox` em `shared/`), `PAGES.md` §2
  (coluna 2: botão fechar, thumbnail de imagem).
- `npm run typecheck` verde nos 4 workspaces. Frontend: suíte completa verde — 74 arquivos, 1039
  testes (inclui os 2 casos novos: thumbnail/lightbox em `MessageBubble.spec.tsx` e botão fechar
  em `ConversationPanel.spec.tsx`).

## 2026-09-17 — CRMLAB-15: correção — thumbnail de imagem não carregava (401 silencioso)

Achado durante validação manual do usuário: o thumbnail nunca aparecia (nem no clique pra abrir o
lightbox). Causa raiz, dois problemas empilhados:

1. `attachmentUrl` devolvido pela API é caminho RELATIVO (`/api/v1/media/:id`) — em produção
   funciona porque o nginx do frontend faz proxy do mesmo origin; em dev, frontend (Vite) e
   backend rodam em origins/portas diferentes, então um `<img src="/api/v1/...">` cru buscava no
   origin ERRADO (o do próprio Vite).
2. Mesmo corrigindo a origem, `GET /media/:id` exige `Authorization` (`requireAuth()`) — um
   `<img src>`/`<a href>` cru NUNCA manda esse header, então a resposta real é 401 (a imagem só
   "não aparece", sem erro visível pro usuário).

- Frontend: `api/client.ts` ganha `resolveMediaUrl` (resolve caminho relativo contra o origin de
  `apiBaseUrl()`) e `fetchAuthenticatedBlob` (busca com `Authorization`, com o mesmo retry de
  refresh do `request()`). Novo hook `hooks/useAuthenticatedImage.ts` busca o blob e devolve um
  `object URL` (`URL.createObjectURL`), revogado a cada troca de mensagem/desmontagem.
  `MessageBubble.tsx` usa o hook em vez da URL crua; enquanto carrega ou se falhar, mostra texto
  no lugar de um `<img>` quebrado.
- Docs: `COMPONENTS.md` (nota no `MessageBubble` sobre a exigência de auth em `/media/:id`).
- `npm run typecheck` verde nos 4 workspaces. Frontend: suíte completa verde — 74 arquivos, 1040
  testes (o teste de thumbnail passou a mockar `fetchAuthenticatedBlob`/`createObjectURL`; +1
  teste novo cobrindo o estado de erro).

## 2026-09-17 — correção: "Desconectar WhatsApp" não surtia efeito em produção ✅

Reportado pelo usuário em produção (vitrocrm.cloud): confirmar a desconexão não fazia nada e o
número seguia "Conectado". Não era a tela — o backend recusava com 503 (6 tentativas nos logs).

Causa raiz, em camadas:

1. A sessão Baileys do número morreu sozinha às 16:17 (`disconnectionReasonCode: 401`), mas o
   Evolution v2.3.7 continuou persistindo `connectionStatus: "open"`. Como `GET /status` lê o
   estado AO VIVO do gateway, a tela mostrava "Conectado" para uma sessão morta.
2. `DELETE /instance/logout` respondia **500 `Error: Connection Closed`** — não há socket para
   deslogar. O service traduzia isso em `CHANNEL_QR_UNAVAILABLE` e, corretamente, NÃO marcava o
   canal como desconectado (não mentir sobre o estado real).
3. `DELETE /instance/delete` também não era saída: recusa com 400 enquanto o registro disser
   `open`. Ciclo fechado — e `/instance/restart` **não** quebra o ciclo (mexe no socket sem
   reavaliar o registro persistido).

Destravado em produção reiniciando o **container** do Evolution (`docker compose restart
evolution`): no boot ele reavalia as sessões, bate no 401 e marca `state: "close"`. A instância
foi preservada — apagá-la custaria as 406 mensagens/76 contatos/99 chats do gateway sem
necessidade.

Dois problemas de diagnóstico corrigidos no código (o usuário ficou cego para a falha):

- A mensagem de `CHANNEL_QR_UNAVAILABLE` é "gateway nao configurado" — enganosa neste caso, já
  que o gateway estava no ar e configurado. Novo código **`CHANNEL_SESSION_STALE`** (503) com
  mensagem acionável, detectado por `isSessionClosed` em `evolution-client.ts`.
  Documentado em `API_ERRORS.md` e em `shared/types/api.types.ts` (`ApiErrorCode`).
- A falha só aparecia em `text-caption` dentro do modal, sem toast — daí "nada acontece".
  `Settings/Channels.tsx` agora também dispara toast (`tone: 'attention'`) no `onError`.

- `npm run typecheck` verde nos 4 workspaces. Backend: 75 arquivos, 1084 testes (+1 novo, com o
  corpo 500 real do v2.3.7 copiado de produção). Frontend: 74 arquivos, 1040 testes. Lint limpo.

## 2026-09-17 — auditoria de confiabilidade do canal WhatsApp ✅

Disparada pela investigação da desconexão (acima). Comparação mensagem a mensagem entre o
banco do Evolution e o do CRM revelou que **30 de 174 mensagens de pacientes do dia (17%)
nunca chegaram ao CRM** — e ninguém percebeu.

**Causa raiz das 30 não foi determinada** e o registro fica honesto sobre isso: os logs do
backend do período se foram no deploy das 17:53 e o Evolution retinha só 2h. Foram
descartadas por evidência: rate limit (os 3754 × 429 estão todos entre 13:15–13:27, e 28 das
30 perdas caem fora), parsing (as perdidas têm o campo `conversation`), sincronização de
histórico (gravadas 1s após o envio, ao vivo), race na criação de conversa (perda igual na 1ª
mensagem e nas demais), truncamento de ID e indisponibilidade do backend.

O que **foi** fechado é o problema estrutural, que é pior que a causa: o webhook responde
`200 {received:true}` em todo caminho de descarte, então o gateway marca "entregue", nunca
reentrega, e a perda não deixa rastro. Seis correções, um commit cada:

1. **Descarte contável** — `DiscardReason` (lista fechada) + `evolution.inbound_discarded`.
   Nem todo motivo é defeito (`from_me`, `grupo` são corretos), mas todos precisam ser
   contáveis.
2. **Tipos que sumiam** — `videoMessage`/`stickerMessage` como mídia;
   `location`/`contact`/`contactsArray` como texto descritivo. Já havia 3 `albumMessage` de
   pacientes perdidos. Sem tipo novo em `MessageType`: vídeo entra como anexo `doc`.
3. **Polling do QR parou de matar a sessão** — `GET /instance/connect` não é leitura: cria
   uma conexão Baileys por chamada. Com polling de 2s, **169 sockets em 3 minutos**, e o
   WhatsApp respondeu com 401. Agora o QR vem por `QRCODE_UPDATED` e cache; `connect` é
   chamado uma vez. Teste prova que 10 pollings mantêm o gateway em 1 chamada.
4. **Queda avisa** — evento WS `channel.connection_changed` + `logger.error` + healthcheck do
   Evolution + rotação de log 50m×5 (a padrão reteve 2h e foi o que impediu achar a causa).
5. **Backup diário** — não existia nenhum; o único dump era anterior a todos os dados de
   produção. Instalado e **verificado** na VPS (`pg_restore -l`: 31 tabelas).
6. **Dedupe no banco** (migração 019, índice único parcial com `tenant_id`) + balde de rate
   limit próprio para o webhook (`RATE_LIMIT_WEBHOOK_PER_MINUTE`, default 600).

Verificação: `npm run typecheck` verde nos 4 workspaces; backend 75 arquivos / **1096
testes**; frontend 74 arquivos / **1042 testes**; lint limpo.

**Não recuperamos as 30 mensagens perdidas** — decisão do usuário.

### Pendências que a auditoria deixou registradas

- **Fila de envio é in-memory** (`lib/queue.ts`, D-011): todo deploy descarta o que estava em
  voo. Bull/Redis já está previsto atrás da mesma interface.
- **Mídia acima do teto** continua sem criar mensagem (spec Onda 8 §4.2): agora deixa rastro
  no log, mas o atendente ainda não vê que o paciente tentou mandar algo.
- **Vídeo aparece como anexo genérico** (`doc`), não como player. Evolução, não pré-requisito.
- **100% do tráfego real chega como `@lid`**, e o telefone depende de `remoteJidAlt` vir no
  payload (hoje vem em 182/182). Se o WhatsApp parar de mandar, a entrada fica cega —
  `lid_sem_remote_jid_alt` no log é o sinal a vigiar.

## 2026-09-18 — suite E2E volta a ficar verde (20 falhas → 0) ✅

O job `E2E (Playwright)` estava vermelho **na `main`** havia pelo menos 5 execucoes, e por isso
tambem no PR #10. Nao era uma causa: eram tres, mais uma corrida que so aparecia na suite
inteira. 20 falhas / 103 passes → **123 passes, 0 falhas**.

### 1. O cartao do pipeline mudou de identidade (10 falhas)

D-103 trocou o rotulo do `ProposalCard` do prefixo do UUID (`#13d4df37`) para o numero
sequencial por tenant (`formatProposalNumber` → `#000042`). O helper `proposalCard()` continuou
procurando os 8 primeiros digitos do id — que nao existem mais em lugar nenhum da tela.

- `proposalCard(page, proposta)` passa a receber a PROPOSTA, nao o id: o numero so existe na
  resposta da API e nao ha como deriva-lo do id. Efeito colateral bom: cartao semeado voltou a
  ser enderecavel (antes todos dividiam o prefixo `a0000000`).
- `criarNoEstagio` (fluxo 3) devolvia a resposta do `PATCH /:id/status`, que e **projecao
  parcial por contrato** (`{ id, status, reasonLost, updatedAt }`) e nao traz `proposalNumber`.
  O `as ProposalDetail` ali sempre foi mentira; agora devolve a proposta criada com o status
  final costurado por cima.
- Onda 7 dividiu `/proposals` em Kanban e Lista, e **so a Lista pagina**. Os tres testes de
  paginacao (D7) navegavam para o Kanban, onde nao existe `navigation "Paginação de propostas"`.
  Passam a abrir `?view=lista`.

### 2. A ficha do paciente mudou e o fluxo 8 nao soube (6 falhas)

D-106 reverteu D-061: `phone` e editavel. O spec ainda afirmava o contrario — e o teste que
mandava `PATCH { phone }` esperando `400` recebia `200`, **gravava** o telefone novo em Carla e
derrubava em cascata dois testes de LGPD que conferem `patient.phone`.

- O teste virou o que D-106 de fato promete: `PATCH` aceito (200) + numero de outro paciente do
  tenant recusado com `409 phone_already_in_use`, com `finally` devolvendo o telefone do seed
  mesmo se uma expectativa falhar no meio.
- `getByLabel('Telefone (não editável)')` → `getByLabel('Telefone', { exact: true })`.
- A secao "Status do cadastro" (CRMLAB-11) fez `getByRole('heading', { name: 'Cadastro' })` casar
  dois nos — `exact: true`.

### 3. Fluxo 14 nunca teve como passar no CI — e escondia um bug de verdade (2 falhas)

O job de E2E **nunca definiu `EVOLUTION_API_URL`/`API_KEY`/`WEBHOOK_TOKEN`**. Sem os tres, as
rotas de QR respondem `503 CHANNEL_QR_UNAVAILABLE` por contrato e o fluxo 14 cai inteiro. Estao
no job agora, apontando para o gateway falso.

Com o ambiente certo, sobrou uma falha real, introduzida pela propria auditoria de 17/09:

- **Bug de producao (`WhatsAppConnectModal`)**: o modal ligava o polling do QR no CLIQUE, em
  paralelo com o `POST /connect`. Como `GET /qr` deixou de chamar `/instance/connect` e passou a
  ler cache, o primeiro polling chegava antes de existir instancia ou cache, respondia
  `disconnected`, e `qrRefetchInterval` **encerrava o polling na primeira tentativa** — modal
  preso em "Gerando QR code..." para sempre. O polling agora liga no `onSuccess` do connect, que
  e o que torna verdadeira a premissa de `getWhatsAppQr` ("o cache nasce populado"). Sem isso a
  conexao por QR estaria quebrada em producao, nao so no teste.
- **Gateway falso**: so virava `open` na SEGUNDA chamada de `/instance/connect` — ou seja, exigia
  exatamente o comportamento que a auditoria removeu. Com o backend correto chamando `connect`
  uma vez, ficava preso em `connecting` para sempre. O avanco pendurou no `connectionState`, que
  e como o pareamento de verdade e observado.

### 4. Uma corrida que so a suite inteira revelava (1 falha)

`flow-3` "perdido exige motivo" lia a API logo depois de clicar em Confirmar, sem esperar o
PATCH. Passava isolado e falhava na suite cheia. Agora espera a resposta.

**Verificacao:** `npm run typecheck` verde nos 4 workspaces; backend 75 arquivos / 1096 testes;
frontend 74 arquivos / 1042 testes; lint limpo; **E2E 123/123** contra Postgres 16 e as duas
telas de pe, com o mesmo roteiro do CI.

## Bloqueios Atuais

Nenhum.

---

## 2026-09-18 — Ambiente de homologação na VPS ✅

`hml` passa a rodar **na mesma VPS** de produção, isolada pelo nome do projeto
Compose (`crm-lab-homolog` × `crm-lab-prod`) — o nome prefixa containers, rede e
**volumes**, então são dois Postgres que não se conhecem. Documento de referência:
**`docs/guides/ENVIRONMENTS.md`** (é o que responde "o que é prod e o que é hml").

| | |
|---|---|
| hml | `/opt/crm-lab-homolog`, porta `127.0.0.1:8081`, imagens `hml-<sha>` |
| prod | `/opt/crm-lab`, porta `127.0.0.1:8080`, imagens `<sha>` — **não foi tocada** |

O risco desse arranjo não é técnico, é humano: um comando no diretório errado
reconstrói produção. Daí o desenho de `scripts/deploy.sh` — **sem flag de
ambiente**, ele descobre onde está e exige que três fontes concordem (diretório,
`APP_ENV`, `COMPOSE_PROJECT_NAME`). A do diretório existe para o caso pior: `.env`
de produção copiado inteiro para o diretório de hml, que sem ela faria um "deploy
de homologação" subir produção em cima do volume de produção. Produção também
exige digitar `PRODUCAO`, recusa `--ref` e confere tag × `version`. Nenhum `down`,
`-v` ou `prune` existe no script.

`scripts/homolog-sincroniza-dados.sh` traz o dado de prod em direção única (prod só
é lida, por `pg_dump`), confere o destino 4× — inclusive o label
`com.docker.compose.project` do container que recebe o `pg_restore --clean` —
guarda o estado anterior de hml antes de sobrescrever, e **desativa os canais de
mensagem** no fim: hml com credencial de canal ativa manda WhatsApp real para
paciente real.

Na tela, `VITE_APP_ENV` (build-time) pinta a pílula **HOMOLOGACAO** no pé da
sidebar. Produção segue sem selo e sem rebuild.

**Verificação:** `npm run typecheck` verde nos 4 workspaces, lint limpo, 33 testes
de `components/layout` verdes; hml respondendo `/healthz` 200 e
`401 INVALID_CREDENTIALS` no login (backend falando com o banco restaurado); prod
`/healthz` 200 e os 5 containers de pé, sem restart; 6 cenários de trava testados
em `/tmp`, todos abortando com saída 1. Custo com as duas stacks: 1.17 GB de 7.9 GB
de RAM, 10 GB de 96 GB de disco.

**Borda concluída no mesmo dia:** `https://homolog.vitrocrm.cloud` com certificado
Let's Encrypt, `401` sem basic auth e `200` com, `noindex`. Duas armadilhas ficaram
documentadas em `ENVIRONMENTS.md`: `caddy validate` rodado como root deixa o log
como `root:root` e faz o reload seguinte ser rejeitado (produção não cai, mas um
restart passaria a derrubar), e o UFW limita a porta 22 a ~6 conexões/30s por IP —
rajada de `ssh` curtos derruba o próprio acesso.

---

## 2026-09-18 — `/results`: redesenho da leitura (UX) ✅

Só forma: nenhum endpoint, cálculo, coluna ou cartão mudou. O que mudou foi
quanto espaço cada coisa ocupa e em que ordem ela se lê.

**O diagnóstico:** a tela cabia em 1180px (largura de LEITURA) com um cabeçalho de
32px, uma barra de filtro de duas alturas — atalhos + dois `Input type="date"` de
largura total, cada um com rótulo empilhado em cima — e um "Carregando..." de uma
linha. Quem importava a planilha gastava meia tela antes de ver um número, e a
tabela de comissão (10 colunas, `minWidth 1100`) rolava na horizontal em qualquer
monitor.

**O que foi feito:**

| Onde | Antes | Agora |
|------|-------|-------|
| `PageContainer` | 1180px fixo | prop `wide` → 1440px, `24px 32px 48px`. Só `/results` usa |
| `PageHeader` | título 32px + descrição 13px | prop `size="compact"` → 21px. O maior tipo da tela passa a ser o KPI (30px) |
| `PeriodFilter` | 4 botões iguais + 2 campos de largura total com rótulo em cima | uma linha: o atalho em vigor fica `primary`/`aria-pressed`, datas viram pílulas de 164px com rótulo DENTRO (`prefix`) |
| Barra de filtro | 3 blocos soltos + "Limpar período" | uma faixa `neutral-100`, com o carimbo da importação na ponta direita. "Limpar período" saiu: clicar em "30 dias" faz o mesmo |
| `ResultsKpiCard` | valor 21px, rótulo caixa alta, delta solto | valor 30px (`MoneyDisplay size="metric"`), rótulo em caixa normal ao lado do ícone, delta em pílula com "vs. período anterior" |
| Gráficos | 50/50 | grade de 12: ranking 7, donut 5. Barra de 34px por atendente (mín. 200px) |
| Carregando | texto "Carregando..." | esqueleto dos 4 cartões, com a altura final — a página não salta |
| Sem dado | frase solta | `EmptyState` com a dica e o botão "Importar planilha" |
| Zona de admin | botão "Limpar base" solto | mesma linha, com a frase do que o botão faz |

**Decisões de leitura:** rótulo de KPI saiu da caixa alta espaçada (não acrescenta
hierarquia quando o valor é 3× maior) e a variação nunca aparece sem a base da
comparação. O carimbo da importação subiu para dentro da barra de filtro porque
"de onde vem" e "de quando é" são a mesma pergunta.

**Verificação:** `npm run typecheck` verde nos 4 workspaces; `npm run test:frontend`
1042 → 1046 testes verdes (4 novos: atalho marcado, período livre sem marca, vazio
com ação de importar, carimbo do arquivo). Docs atualizados no mesmo commit —
`PAGES.md` §3 e §14, `COMPONENTS.md` (`PageContainer wide`, `PageHeader size`,
`MoneyDisplay size`, `PeriodFilter`).

**Pendente:** validação visual em `https://homolog.vitrocrm.cloud`. Nada foi
visto em navegador nesta máquina — jsdom não desenha, e subir a stack local
esbarra na inspeção de TLS.

---

## 2026-09-18 — `/results`: evolução do faturamento + donut lendo o RECEBIDO ✅

Duas mudanças pedidas na validação do redesenho, as duas com backend.

**1. "Evolução do faturamento" entrou na tela.** O `MonthlySeriesChart` existia
no código desde a Onda 10 e **não era usado por ninguém** — a série de 12 meses
só aparecia no PDF. Foi redesenhado como área sobreposta com TRÊS séries (orçado,
em requisição, recebido) e colocado em largura inteira logo abaixo dos KPIs.
`requisitionValue` é novo em `ExecutiveReportMonthlyPoint`: vem da janela de
EMISSÃO com dedupe por requisição, a mesma definição do KPI "Em Requisição"
(D-125). Sobreposta e nunca empilhada — os três números já se contêm.
Como `/reports/executive` não aceita filtro de convênio (D-116), com o filtro
ligado o cartão diz isso em nota, em vez de responder outra pergunta calado.

**2. O donut passou a ler o RECEBIDO.** Ele desenhava `byInsurance.totalValue`,
que é `SUM(total_value)` da janela de emissão — ou seja, mostrava **orçado** com
o título de distribuição de faturamento. `LisInsuranceAgg` ganhou `paidValue`
(janela de pagamento, dedupe por requisição) e o corte do top 6 passou a ser por
ele: ordenar por orçado deixava de fora o convênio que paga bem e orça pouco. A
query virou `FULL JOIN` entre as duas janelas, então convênio com pagamento no
período e emissão fora dele aparece com `count: 0` — antes sumia. O fecho
"Outros" agora fecha contra o KPI "Recebido", que é a mesma janela das fatias.

**Conferência dos cartões** (pedida junto): Total Orçado, Em Requisição,
Atendentes, o delta e a barra de conversão batem com as definições de
BUSINESS_RULES.md §11 e D-125. **Uma ressalva fica registrada:** a legenda do
cartão "Recebido" diz "X% do orçado" dividindo a janela de PAGAMENTO pela de
EMISSÃO — pagamento de orçamento emitido antes do período entra no numerador sem
estar no denominador, e o número pode passar de 100% (é exatamente por isso que
`conversionQty` é capado). Mantido como estava, por ser o comportamento
documentado desde a Onda 10; trocar a base é decisão de produto.

**Também atualizado:** o PDF executivo passou a levar as três colunas na série
mensal e "Orçado (R$) / Recebido (R$)" na tabela de convênios.

**Verificação:** `npm run typecheck` verde nos 4 workspaces; backend 1099 testes
verdes (3 novos: `paidValue` por convênio, ordenação pelo recebido, convênio pago
sem emissão no período, série mensal separando as três janelas); frontend 1047
verdes (1 novo: evolução na tela + legenda do donut em cima do recebido). Docs no
mesmo commit: `API_CONTRACTS.md` §5c/§10.2, `PAGES.md` §14, `shared/types`.

## 2026-09-19 — CRMLAB-19: anexo derrubava a tela em todo build de produção ✅

Abrir qualquer conversa com anexo quebrava a rota inteira com
`TypeError: Invalid base URL`. Não era a bolha da mensagem falhando: o erro subia
durante a renderização e o React derrubava a tela.

**Causa.** `resolveMediaUrl` (`frontend/src/api/client.ts`) monta a URL do anexo
com `new URL(caminho, base)`, que **exige base absoluta**. No build de produção a
base é **relativa** — `VITE_API_URL=/api/v1` (`frontend/Dockerfile:32`,
`docker-compose.prod.yml:140`) — e `new URL('/api/v1/media/<id>', '/api/v1')`
lança. A base é relativa de propósito: ali o nginx serve SPA e API no mesmo
origin, e um origin fixo no bundle quebraria em qualquer outro domínio. O defeito
estava em quem consome a base.

**Por que passou.** Em dev `VITE_API_URL` é absoluta (`frontend/.env`), então só
o build real falhava — e a função não tinha **nenhum** teste. Atingia produção
igual: a próxima foto de paciente quebraria a tela do atendente.

**Correção.** Base relativa significa "mesmo origin", que é o que o nginx faz —
então `window.location.origin` é a base CORRETA, não um fallback. Três testes de
regressão em `client.spec.ts` (base relativa, base absoluta, URL já absoluta),
verificados contra o código antigo: falham com `Invalid base URL: /api/v1`.

**Como apareceu.** Montando `scripts/simula-webhook-evolution.sh`, que simula o
webhook do Evolution em homologação — imagem, PDF, áudio, vídeo e os descartes —
**sem parear número de WhatsApp**. Funciona porque a mídia do gateway vem em
base64 no próprio corpo do webhook; o backend não baixa nada. O script posta de
dentro do container do backend (mesma posição de rede do gateway, que não passa
pelo nginx) e confere no BANCO, por `external_message_id` — o webhook responde
200 sempre, por desenho anti-oráculo, então a resposta HTTP não prova nada.
A primeira conversa com anexo que ele gerou derrubou a tela.

**Verificação:** `npm run typecheck` verde nos 4 workspaces; frontend 1050 testes
verdes (3 novos). Simulação: 10/10 casos passando em hml.

**Fica registrado, fora do escopo deste card:** o nginx do frontend não define
`client_max_body_size`, então vale o default de **1 MiB** — medido em hml, 2 MB
no `/api/` devolve 413. O backend aceita 25 MB (`app.ts:118`) e o `MediaService`
15 MiB, mas a borda corta antes. Atinge o ENVIO de anexo
(`Attendance/index.tsx:168`) e a importação de planilha do LIS
(`lis-import.routes.ts:62`) acima de ~750 KB, porque base64 infla ~33%. O
RECEBIMENTO não sofre: o gateway posta direto no backend.
