# 📊 STATUS do Projeto

Arquivo de coordenação vivo. Todo agente atualiza aqui ao reivindicar, avançar ou concluir tarefas.

**Última atualização:** 2026-09-05 (Onda 8 §2 entregue: transferência com menu, emoji e fixar conversa)

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
| §3 Onda 2 — macros (respostas rápidas) | — | ⬜ | — | Não iniciar antes de validar e commitar a Onda 1 (decisão do lead) |
| §4 Onda 3 — mídia (anexo e áudio) | — | ⬜ | — | Depende de armazenamento, que não existe no projeto hoje |

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

## Bloqueios Atuais

Nenhum.
