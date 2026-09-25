# ⚙️ Serviços do Backend

Especificação de cada serviço: responsabilidade, interface pública e dependências. O Agent-API implementa exatamente estas interfaces.

---

## Mapa de Serviços

```
AuthService ──────────┐
                      ├──→ (JWT context: userId, tenantId, role)
TenantContext ────────┘
        │
        ▼ (todos os serviços abaixo exigem contexto)
ConversationService ←→ MessageService ←→ WhatsAppService (externa)
        │
        ▼
ProposalService ←→ ExamCatalogService
        │
        ├──→ ApprovalService ──→ InternalChatService
        │
        ▼
AnalyticsService (read-only sobre proposals)
ThemeService
AuditService (write-only, chamado por todos)
QuickReplyService (macros do Composer, sem dependência de outro service)
```

---

## 1. AuthService

**Responsabilidade:** Login, tokens, refresh, contexto multitenant.

```typescript
interface AuthService {
  login(email: string, password: string): Promise<LoginResult>;
  refresh(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }>;
  logout(refreshToken: string): Promise<void>;
  validateToken(token: string): Promise<JwtPayload>; // { userId, tenantId, role }
}
```

**Regras:**
- bcrypt para senhas (cost 12)
- accessToken 15 min, refreshToken 7 dias (armazenado hasheado no Redis)
- Login falho não revela se email existe ("credenciais inválidas")
- Verificar `user.isActive` E `tenant.isActive`

---

## 2. ConversationService

**Responsabilidade:** CRUD de conversas, atribuição, arquivamento.

```typescript
interface ConversationService {
  list(tenantId: string, filters: ConversationFilters): Promise<Paginated<Conversation>>;
  getById(tenantId: string, id: string): Promise<ConversationDetail>;
  findOrCreateByPhone(tenantId: string, phone: string): Promise<Conversation>;
  assign(tenantId: string, id: string, userId: string | null): Promise<Conversation>;
  // D-174: so dona/gestor/admin; 'closed' grava evento de sistema. Reabertura manual: createManual.
  updateStatus(tenantId: string, id: string, status: 'active' | 'closed'): Promise<Conversation>;
  markAsRead(tenantId: string, id: string, userId: string): Promise<void>;
}
```

**Implementado (Agent-API-Conversations):** as assinaturas que precisam saber QUEM está
agindo recebem `TenantContext` no lugar de `tenantId` — `list(ctx, filters)`,
`getById(ctx, id)`, `assign(ctx, id, userId)`, `updateStatus(ctx, id, status)`,
`markAsRead(ctx, id)`, mais `update(ctx, id, patch)` (o `PATCH` do contrato) e
`updateTags(ctx, id, tags)`. `findOrCreateByPhone(tenantId, phone, patientName?)`
continua recebendo só `tenantId`: quem chama é o webhook, sem usuário logado.
Ver "Convenções Transversais" — o contexto é sempre o primeiro parâmetro.

`createManual(ctx, dto)` é o `POST /conversations` (atendimento fora do WhatsApp,
API_CONTRACTS.md §2). Passa pelo mesmo `findOrCreateByPhone` — o canal vem do DTO e
`assignedTo` nasce com `ctx.userId`, em vez da fila livre. O telefone digitado é
normalizado para `+55…` antes da busca (o webhook grava com código do país; sem isso o
dedupe erraria justamente no paciente que já conversa pelo WhatsApp). Conversa
preexistente **não** troca de dono; se ela for de outro atendente, lança
`CONVERSATION_ALREADY_ASSIGNED` — o 404 do recorte por papel mandaria o atendente montar
orçamento numa conversa que ele não abre.

**Regras:**
- `assign` com conflito simultâneo: primeira atribuição ganha. Implementado com
  `UPDATE ... WHERE assigned_to IS NULL` em vez do lock otimista por `updated_at`
  (D-023): a condição está na própria escrita, então não existe leitura prévia que
  possa envelhecer. Quem perde recebe `CONVERSATION_ALREADY_ASSIGNED` com
  `details: { assignedTo, assignedToName }`
- Atendente só lista as próprias + não atribuídas; gestor/admin listam todas.
  A mesma regra vale para LER uma conversa: a de outro atendente devolve `NOT_FOUND`
  (nunca `FORBIDDEN`). A exceção é `assign`, que devolve o 409 acima — quem clicou
  "Assumir" tarde demais precisa saber de quem a conversa é
- `ListConversationsResponse.counts` (`mine` / `unassigned`) sai do MESMO `SELECT` da
  listagem, via `COUNT(*) FILTER (...)` — nunca de contador separado (BUSINESS_RULES §5)
- Busca por nome usa `to_tsvector('portuguese', COALESCE(patient_name, ''))`, a mesma
  expressão do índice GIN da migração 001 (expressão diferente = índice não usado);
  por telefone, comparando só dígitos
- Transferência gera mensagem de sistema "Conversa transferida de A para B" e preserva
  o histórico (WORKFLOWS §5)
- `markAsRead` zera `unread_count` e marca mensagens. `GET /conversations/:id` chama-o
  (PAGES.md §2 "Ao abrir: markAsRead"); `POST /conversations/:id/read` é o caminho
  explícito
- **`findOrCreateByPhone` cria ou reaproveita o paciente e grava `conversations.patient_id`
  na mesma transação (D-072).** A ligação mora no *repositório*, sobre a `DbTx` já aberta —
  chamar `PatientService` daqui abriria um segundo `withTenant` e travaria (D-008, uma
  conexão só). O nome vindo do perfil do canal **preenche** cadastro sem nome e **nunca**
  sobrescreve nome existente; paciente anonimizado (D-063) não é revivido. Conversa legada
  com `patient_id NULL` é religada no primeiro contato novo

---

## 3. MessageService

**Responsabilidade:** Mensagens de conversa, envio via canal externo, eventos WS.

```typescript
interface MessageService {
  listByConversation(tenantId: string, conversationId: string, page: Pagination): Promise<Paginated<Message>>;
  createFromAgent(tenantId: string, conversationId: string, senderId: string, dto: CreateMessageDTO): Promise<Message>;
  createFromPatient(tenantId: string, conversationId: string, dto: InboundMessageDTO): Promise<Message>; // via webhook
  createFromPhone(tenantId: string, conversationId: string, dto: InboundMessageDTO): Promise<Message | null>; // fromMe via webhook (D-173); null = eco do CRM
  createSystemEvent(tenantId: string, conversationId: string, content: string): Promise<Message>;
}
```

**Implementado (Agent-API-Conversations):** `createSystemEvent(tenantId,
conversationId, content): Promise<Message>` — exatamente a assinatura acima; é a
interface que ProposalService/ApprovalService consomem. Instanciação:
`createMessageService(deps)` a partir de `ApiModuleDeps`. `createFromPatient` recebe
`InboundMessageInput` (`content`, `messageType?`, `attachmentUrl?`, `externalId?`).

**Regras:**
- `createFromAgent` → chama WhatsAppService.send() → atualiza `status` conforme callback.
  A mensagem é persistida ANTES do envio: falha de canal deixa a linha com
  `status: 'failed'` e devolve `MESSAGE_SEND_FAILED` (502) — a bolha não some da tela
- Toda criação emite `conversation.new_message` no WebSocket (room = tenantId)
- `createSystemEvent` usado por: orçamento enviado, transferência, proposta ganha.
  Funciona em conversa encerrada (o fato aconteceu) e NÃO incrementa `unread_count`
- Enviar mensagem de agente em conversa encerrada → `CONVERSATION_ARCHIVED` (409, nome mantido — D-174)
- `createFromPatient` em conversa `closed` REABRE antes de gravar (D-174): `active`, sem dona,
  evento "Atendimento reaberto pelo paciente". `createFromPhone` (`fromMe`) não reabre
- `createFromPatient` incrementa `unread_count`, sobe `last_message_at` (mesma
  transação do INSERT) e é idempotente por `external_message_id` — a reentrega do
  canal não duplica mensagem nem evento
- `createFromPhone` (D-173, CRMLAB-46) é o `fromMe: true` do Evolution. Devolve `null` quando é
  **eco** do CRM: `externalId` já gravado, ou gravado durante a espera pelo envio em voo
  (`MessageRepository.hasPendingOutbound` — atendente com autor, `status: sent`, sem
  `externalId`, < 60 s; sondagem de 250 ms até 8 s, relógio injetável). Senão grava
  `sender_type: agent`, `sender_id: NULL`, `status: sent` — sem incrementar `unread_count`,
  subindo `last_message_at`, emitindo `conversation.new_message` — e é idempotente por
  `external_message_id` como `createFromPatient`
- `setStatus` com `externalId` que já é de uma cópia do celular (envio mais lento que a espera)
  apaga a cópia e grava o id na mensagem do CRM, na mesma transação; o service reemite
  `conversation.new_message`

---

## 4. ProposalService (CORAÇÃO DO SISTEMA)

**Responsabilidade:** Criação e ciclo de vida das propostas, cálculo de valores, alçada.

```typescript
interface ProposalService {
  create(ctx: TenantContext, dto: CreateProposalDTO): Promise<Proposal>;
  getById(ctx: TenantContext, id: string): Promise<ProposalDetail>;
  list(ctx: TenantContext, filters: ProposalFilters): Promise<Paginated<Proposal>>;
  updateStatus(ctx: TenantContext, id: string, status: ProposalStatus, reasonLost?: string): Promise<Proposal>;
  updateDiscount(ctx: TenantContext, id: string, discountPercent: number): Promise<Proposal>;
  /** CRMLAB-52 (D-119). Dona ou manager+. Grava o vínculo e concilia na mesma transação. */
  setLisReference(ctx: TenantContext, id: string, lisBudgetNumber: string | null): Promise<ProposalDetail>;
  /** CRMLAB-52 (D-119). Só para LisReconcileService (§25), dentro da transação dele. */
  markWonFromLis(tx: DbTx, tenantId: string, proposalId: string): Promise<boolean>;
}
```

**Regras (ver BUSINESS_RULES.md §1-3):**
- `create`: busca preços ATUAIS do catálogo (ignora preços vindos do cliente); snapshot em items
- `totalPrice = Σ(items.unitPrice × qty) × (1 − discount/100)` — recalculado a CADA escrita
- Se `discount > user.discountLimit` → `approvalStatus = 'pending'` + dispara ApprovalService
- `updateStatus`: valida matriz de transições (WORKFLOWS.md §4); `perdido` exige `reasonLost` válido
- Proposta `pending` não pode ir para `orcamento_enviado`
- `ganho`/`perdido` são terminais: seta `closedAt`, nenhuma transição posterior
- Toda mutação → AuditService
- **`markWonFromLis` (D-119 item 4)** é a única transição que ignora `ALLOWED_TRANSITIONS`: vai
  de **qualquer** estágio não terminal para `ganho`, porque quem fechou foi o LIS. Ela e o
  `updateStatus` compartilham um `transitionInTx(tx, …)` extraído do `updateStatus`: histórico,
  `closedAt`, mensagem de sistema ("Orçamento convertido em requisição no LIS"), invalidação de
  analytics, audit `update_proposal_status` com `newValues.source: "lis"` e `userId: null`, e WS
  `proposal.status_changed` **depois do commit**. O `UPDATE ... WHERE status NOT IN
  ('ganho','perdido') RETURNING` decide: 0 linhas → devolve `false` e não emite nada
  (idempotência, D-119 item 7). Proposta `pending` de aprovação também fecha: o LIS confirmou que
  o paciente pagou/requisitou, e a alçada era sobre o desconto oferecido, não sobre o fato.
- **`setLisReference`:** normaliza o número (D-119 item 1), recusa em `ganho`
  (`PROPOSAL_ALREADY_CLOSED`), traduz a violação do índice único para `CONFLICT
  lis_budget_number_taken` e chama `LisReconcileService.reconcileProposal` na mesma transação.

---

## 5. ExamCatalogService

**Responsabilidade:** Catálogo de exames do tenant.

```typescript
interface ExamCatalogService {
  /**
   * Onda 7: `filters.insuranceId?: string`. Quando presente, cada `Exam` do resultado vem
   * com `effectivePrice: number` e `priceSource: 'insurance' | 'private'` (fallback para
   * `pricePrivate` quando não há linha em `exam_prices` para o par exame/convênio).
   */
  list(tenantId: string, filters: ExamFilters): Promise<Paginated<Exam>>;

  /** Ativos E inativos, na ordem dos ids pedidos. Ids desconhecidos são omitidos. */
  getByIds(tenantId: string, ids: string[]): Promise<Exam[]>;

  /**
   * Versão estruturada de getByIds para quem precisa saber o que falhou.
   * Onda 7: 3º parâmetro `insuranceId?: string` — quando presente, cada entrada de `byId`
   * ganha `effectivePrice`/`priceSource` com a mesma lógica de fallback de `list`. **É esta
   * assinatura que o ProposalService (§4) consome** para precificar por convênio.
   */
  resolveActiveByIds(tenantId: string, ids: string[], insuranceId?: string): Promise<ExamResolution>;

  create(ctx: TenantContext, dto: CreateExamRequest): Promise<Exam>;     // manager/admin
  update(ctx: TenantContext, id: string, dto: UpdateExamRequest): Promise<Exam>; // manager/admin

  /** Onda 7. Uma linha por convênio COM preço cadastrado para este exame. Qualquer papel do tenant. */
  listPrices(ctx: TenantContext, examId: string): Promise<ExamPrice[]>;

  /**
   * Onda 7. Upsert em lote — semântica de PUT (estado completo): linha ausente do corpo é
   * removida. manager/admin. Valida que cada `insuranceId` do corpo existe e está ativo no
   * tenant, senão `NOT_FOUND`/`VALIDATION_ERROR`. Invalida `cache.delByPrefix('exams:<tenantId>:')`.
   */
  upsertPrices(ctx: TenantContext, examId: string, dto: UpdateExamPricesRequest): Promise<ExamPrice[]>;
}
// Nota de camada: `listPrices`/`upsertPrices` devolvem ARRAY cru (`ExamPrice[]`), não
// `ListExamPricesResponse`. Cada forma está certa na sua camada — o service devolve o dado, e
// é `exam.routes.ts` (GET/PUT /exams/:id/prices) quem embrulha em `{ prices }` na resposta
// HTTP, obedecendo a regra de envelope de listagem (D-070, API_CONTRACTS.md §4). Não é
// divergência a "consertar": `ListExamPricesResponse` é forma de fio HTTP, não de retorno de
// service — o mesmo padrão de `list()` acima, que devolve `Paginated<Exam>` e não
// `ListExamsResponse`.

interface ExamResolution {
  found: Exam[];            // somente ATIVOS, na ordem dos ids pedidos
  byId: Map<string, Exam>;  // os mesmos de `found`, indexados — com effectivePrice/priceSource
                             // quando `insuranceId` foi passado (Onda 7)
  invalidIds: string[];     // missingIds + inactiveIds — vai direto em details.examIds
  missingIds: string[];     // não existem neste tenant (ou pertencem a outro)
  inactiveIds: string[];    // existem mas estão com isActive:false
}
```

**Regras:**
- `code` único por tenant → `CONFLICT` (409). Verificado antes do INSERT e, em corrida,
  pelo índice único (`23505` convertido para `CONFLICT`, nunca 500)
- Desativar (`isActive: false`) em vez de deletar — propostas históricas referenciam.
  **Não há endpoint DELETE**; `getByIds` continua devolvendo o exame desativado
- Cache 1h (`EXAM_CACHE_TTL_SECONDS = 3600`), invalidado em create/update **e em
  `upsertPrices`** (Onda 7)
- Busca (`?search=`) por **nome, código e sinônimo** (Onda 7), sem sensibilidade a caixa nem a
  acento (dobra via `translate` no SQL — `unaccent` não está disponível no PGlite dos testes).
  Sinônimo é o terceiro ramo do `OR`, sobre `exam_synonyms` (SCHEMA.md §20)
- Filtros: `?active=`, `?category=` (também sem acento/caixa), `?page`/`?limit`
  (default 1/20, máx. 100), `?sortBy`/`?order` (whitelist de colunas), `?insuranceId=` (Onda 7)
- **Onda 7 — TUSS/AMB/material/sinônimos:** `create`/`update` aceitam `tussCode`, `ambCode`,
  `material` (colunas simples) e `synonyms?: string[]` — regravado por
  delete-then-insert em `exam_synonyms`, **dentro da mesma transação** do create/update
  (semântica de PUT sobre a coleção filha: enviar `synonyms` substitui o conjunto inteiro).
  `list`/`getByIds` populam `synonyms: string[]` via `LEFT JOIN LATERAL` (`[]` quando nenhum).
  Código TUSS/AMB não confirmado é `null`, nunca inventado (D-081).
- **Onda 7 — preço por convênio:** `listPrices`/`upsertPrices` são donos de `exam_prices`
  (SCHEMA.md §19), com o mesmo padrão transacional de sinônimos (delete-then-insert). No `list`
  com `insuranceId`, o SQL faz `LEFT JOIN exam_prices ep ON ep.exam_id = e.id AND
  ep.insurance_id = $insuranceId` e projeta
  `COALESCE(ep.price, e.price_private) AS effective_price,
  CASE WHEN ep.price IS NOT NULL THEN 'insurance' ELSE 'private' END AS price_source`
  — **o fallback nunca bloqueia** (decisão 4 do spec da Onda 7). A chave de cache da listagem
  (`listCacheKey`) incorpora `insuranceId` no hash.

**Cache — chave e invalidação:**
- Chave: `exams:<tenantId>:list:<filtros normalizados>` (inclui `insuranceId` desde a Onda 7).
  O `tenantId` é o **primeiro segmento**: cache que vaza entre tenants é falha de isolamento
  igual a uma query sem `WHERE tenant_id`.
- Invalidação: `cache.delByPrefix('exams:<tenantId>:')` em create/update/`upsertPrices` —
  derruba todas as combinações de filtro daquele tenant e de nenhum outro.

**`getByIds` / `resolveActiveByIds` NÃO passam pelo cache** — de propósito. O ProposalService
lê por aqui o preço **atual** do catálogo (BUSINESS_RULES §1, WORKFLOWS §2 passo 5); servir esse
caminho de cache arriscaria gravar uma proposta com preço obsoleto. Custo: uma query por PK.
Vale também para o preço por convênio (Onda 7): `resolveActiveByIds(..., insuranceId)` não lê
`exams:<tenantId>:` — preço de convênio nunca sai obsoleto, mesma razão do preço particular.

Uso pelo ProposalService (Onda 7 — com convênio):

```typescript
const resolution = await examCatalog.resolveActiveByIds(ctx.tenantId, ids, dto.insuranceId ?? undefined);
if (resolution.invalidIds.length > 0) {
  throw new BusinessError('EXAM_NOT_FOUND_OR_INACTIVE', { examIds: resolution.invalidIds });
}
// resolution.byId[examId].effectivePrice / .priceSource viram o snapshot do item
// (unitPrice / priceSource em proposal_items, D-004 estendido)
```

---

## 6. ApprovalService

**Responsabilidade:** Fluxo de aprovação de descontos acima da alçada.

```typescript
interface ApprovalService {
  requestApproval(ctx: TenantContext, proposalId: string): Promise<void>;
  approve(ctx: TenantContext, proposalId: string): Promise<Proposal>;
  reject(ctx: TenantContext, proposalId: string, reason: string): Promise<Proposal>;
  listPending(ctx: TenantContext): Promise<Proposal[]>;
}
```

**Regras:**
- `requestApproval`: posta no canal interno `#aprovacoes` com proposta anexada + notifica gestores via WS
- `approve`: só manager/admin; e só se `discount <= approver.discountLimit`
- `reject`: motivo obrigatório; notifica criador
- Decisões auditadas

---

## 7. InternalChatService

**Responsabilidade:** Canais e DMs internos do laboratório.

```typescript
interface InternalChatService {
  listChannels(ctx: TenantContext): Promise<Channel[]>;
  listMessages(ctx: TenantContext, channelId: string, page: Pagination): Promise<Paginated<InternalMessage>>;
  send(ctx: TenantContext, channelId: string, dto: { content: string; attachedProposalId?: string }): Promise<InternalMessage>;
  createSystemPost(tenantId: string, channelKey: string, content: string, attachedProposalId?: string): Promise<void>;

  /** Onda 6 (D-068): zera o unreadCount do canal para o usuário do ctx. Idempotente. */
  markChannelRead(ctx: TenantContext, channelId: string): Promise<void>;

  /** D-101: diretório de usuários do tenant elegíveis a DM (exclui o próprio ctx.userId e inativos). */
  listDirectory(ctx: TenantContext): Promise<ChatDirectoryUser[]>;

  /** D-101: get-or-create idempotente da DM com otherUserId. Mesmo par → mesmo canal sempre. */
  getOrCreateDirectChannel(ctx: TenantContext, otherUserId: string): Promise<Channel>;
}
```

**Regras:**
- Canais padrão criados no onboarding: `#geral`, `#aprovacoes`
- Proposta anexada renderiza como cartão (frontend resolve via GET /proposals/:id)
- Console de plataforma tem chat PRÓPRIO, isolado (sem acesso aos canais de labs)
- **DM (D-101, migração `010_internal_chat_dm.sql`, SCHEMA.md §11):** `getOrCreateDirectChannel`
  rejeita `otherUserId === ctx.userId` (`VALIDATION_ERROR`) e exige que `otherUserId` exista,
  esteja ativo e no MESMO tenant (`NOT_FOUND` — RLS já esconde usuário de outro tenant). A chave
  é `dm:{menorId}:{maiorId}` (par ordenado, `dm_user_a_id < dm_user_b_id`); `INSERT ... ON
  CONFLICT (tenant_id, key) DO NOTHING` seguido de `SELECT` no conflito é o que torna a criação
  idempotente sem duas linhas para o mesmo par
- **Visibilidade de DM é por participante:** `listChannels` e `findChannelById` (usado por
  `listMessages`/`send`/`markChannelRead`) filtram `kind = 'channel' OR ctx.userId IN
  (dm_user_a_id, dm_user_b_id)` — uma DM alheia (mesmo tenant, mas o usuário não é um dos dois
  participantes) é `NOT_FOUND`, nunca aparece em `listChannels` nem é acessível por id adivinhado
- `Channel.otherUserId`/`otherUserName` só existem em `kind: "dm"` — é o OUTRO participante,
  resolvido por quem pergunta; o `name` gravado na linha da DM é interno e nunca é exibido
- `listDirectory` não pagina nem busca — laboratório pequeno o bastante para uma lista só
- **`unreadCount` é derivado de `channel_reads` (D-068, SCHEMA.md §17), não mais `0` fixo**
  (supera D-044): conta mensagens do canal com `created_at > last_read_at` cujo `sender_id` não
  é o do usuário. Mensagem de sistema conta. Sem linha de leitura, conta todas as de terceiros.
  `Channel.lastReadAt` acompanha, para a tela desenhar o divisor de "novas mensagens"
- `markChannelRead` é
  `INSERT ... ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = NOW()` — idempotente
  por construção, sem leitura prévia. Canal de outro tenant → `NOT_FOUND`. Não gera audit log
- **`listMessages` pagina do fim (D-069):** `page=1` é a fatia das mensagens **mais recentes**,
  com os itens em ordem cronológica crescente **dentro** da página; `page=2` é o bloco
  anterior. O `OFFSET` é `max(0, total - page * limit)` e o `LIMIT` da última página é o resto.
  Um chat abre no fim; paginar do começo obrigava a tela a fazer dois requests (um só para
  descobrir `totalPages`)
- `listMessages` **não** marca o canal como lido: ler página antiga do histórico não é ter
  visto a mensagem nova. É a diferença deliberada para `GET /conversations/:id` (D-035), onde
  a página 1 é literalmente o fim da conversa

---

## 8. ThemeService

**Responsabilidade:** Personalização visual do tenant.

```typescript
interface ThemeService {
  getCurrent(tenantId: string): Promise<Theme>;
  update(ctx: TenantContext, dto: UpdateThemeDTO): Promise<Theme>; // admin only
  getPresets(): ThemePreset[]; // os 5 temas prontos (estático)
}
```

**Regras:**
- Armazena SÓ as 5 cores base + radiusId + fontId + brand (D-005)
- Validar formato hex das cores
- Theme retorna no payload de login (evita request extra)

---

## 9. AnalyticsService

**Responsabilidade:** Métricas de conversão e pipeline. READ-ONLY.

```typescript
interface AnalyticsService {
  getConversionFunnel(ctx: TenantContext, period: DateRange): Promise<FunnelReport>;
  getPipelineSnapshot(ctx: TenantContext): Promise<PipelineSnapshot>;
  getTeamPerformance(ctx: TenantContext, period: DateRange): Promise<TeamReport>; // gestor/admin
}
```

**Regras:**
- TODOS os números derivam de `proposals` (nunca contadores separados) — BUSINESS_RULES.md §5
- Cache Redis 5 min por (tenantId, período)
- Atendente vê apenas métricas próprias (conversão "parcial")

---

## 10. AuditService

**Responsabilidade:** Log imutável de ações críticas.

```typescript
interface AuditService {
  log(entry: {
    tenantId: string; userId: string | null;
    action: string; entityType: string; entityId: string;
    oldValues?: object; newValues?: object;
    ipAddress?: string; userAgent?: string;
  }): Promise<void>;
  query(ctx: TenantContext, filters: AuditFilters): Promise<Paginated<AuditEntry>>; // admin only
}
```

**Regras:**
- Append-only: sem update/delete
- `log()` nunca lança exceção que quebre a operação principal (fire-and-forget com retry em fila)

---

## 11. WhatsAppService (Integração Externa)

**Responsabilidade:** Adapter para WhatsApp Business API.

```typescript
interface WhatsAppService {
  send(tenantId: string, phone: string, content: string): Promise<{ externalId: string }>;
  handleWebhook(payload: unknown): Promise<InboundMessageDTO>; // valida assinatura!
  handleStatusCallback(payload: unknown): Promise<{ externalId: string; status: MessageStatus }>;
}
```

**Implementado (Agent-API-Conversations):** `handleWebhook` e `handleStatusCallback`
devolvem **lista** (`InboundMessageDTO[]` / `StatusCallbackDTO[]`) — a Meta entrega
lote, e descartar as demais mensagens de um POST perderia mensagem de paciente (D-025).
Nenhum dos dois lança: payload malformado devolve lista vazia.

**Regras:**
- Credenciais por tenant (cada lab conecta seu número) — resolvidas por
  `WhatsAppCredentialsResolver`. **A tabela existe a partir da Onda 6**: o resolver passa a
  consultar `ChannelSettingsService.resolveCredentials(tenantId, 'whatsapp')`
  (`tenant_channels`, SCHEMA.md §15) e cai nas env vars **campo a campo** — linha ausente ou
  coluna nula (D-073), e não "linha existe ⇒ ignora env": um laboratório pode ter conectado o
  número sem ainda ter girado o segredo do webhook. É isso que mantém dev e CI funcionando sem
  nenhuma linha na tabela. Fecha o pedido de D-024; a identidade do tenant continua vindo do
  slug na URL do webhook. `apiUrl` fica fora da tabela: é endereço da API do canal (e decide
  driver mock × real), não credencial do laboratório
- **Aberto:** `findCredentials` não filtra `is_active` — um canal desativado na tela continua
  alimentando o webhook. Comportamento não definido em contrato; ver `docs/STATUS.md`
- Webhook: validar assinatura HMAC antes de processar, com `crypto.timingSafeEqual`
  (comparação de string vaza o dígito certo pelo tempo de resposta)
- Envio em fila com retry exponencial (3 tentativas) → status `failed` após esgotar.
  A fila é `src/lib/queue.ts` (`QueueService`, driver in-memory; Bull/Redis entra atrás
  da mesma interface — D-011). O relógio é injetável, então o retry é testável em
  milissegundos
- Em dev/teste: driver mock que ecoa mensagens (escolhido por `WHATSAPP_API_URL` vazia)

---

## 12. PatientService (Onda 6 — D-059)

**Responsabilidade:** cadastro do paciente, timeline de interações e os dois caminhos de LGPD.
Dono da tabela `patients` (SCHEMA.md §14) e da coluna `conversations.patient_id`.

```typescript
interface PatientService {
  list(ctx: TenantContext, filters: ListPatientsQuery): Promise<ListPatientsResponse>;
  getById(ctx: TenantContext, id: string): Promise<PatientDetail>;
  update(ctx: TenantContext, id: string, dto: UpdatePatientRequest): Promise<PatientDetail>;
  timeline(
    ctx: TenantContext,
    id: string,
    query: ListPatientTimelineQuery,
  ): Promise<ListPatientTimelineResponse>;

  /** LGPD — admin. Dump completo do titular, SEM recorte por papel (D-062). */
  exportData(ctx: TenantContext, id: string): Promise<PatientExport>;

  /** LGPD — admin. Anonimiza cadastro + cópias denormalizadas (D-063). Idempotente. */
  anonymize(
    ctx: TenantContext,
    id: string,
    dto: AnonymizePatientRequest,
  ): Promise<AnonymizePatientResponse>;

  /** Qualquer papel de laboratório (D-133, CRMLAB-11). Idempotente. */
  inactivate(
    ctx: TenantContext,
    id: string,
    dto: InactivatePatientRequest,
  ): Promise<PatientDetail>;

  /** Qualquer papel de laboratório (D-133). Idempotente. */
  reactivate(
    ctx: TenantContext,
    id: string,
    dto: ReactivatePatientRequest,
  ): Promise<PatientDetail>;
}
```

**Não existe `PatientService.findOrCreateByPhone`.** O paciente nasce do canal, e nasce dentro
da transação da conversa — ver a regra de nascimento abaixo.

**Regras:**
- **Visibilidade (D-060):** atendente enxerga apenas pacientes com ao menos uma conversa
  visível para ele (atribuída a ele **ou** não atribuída) — o mesmo recorte do
  ConversationService §2. Gestor/admin veem todos. Fora da visibilidade: `NOT_FOUND`, nunca
  `FORBIDDEN`. O recorte vale para `list`, `getById`, `update` e `timeline`, **e também para os
  contadores e as entradas da timeline** — senão a ficha viraria um caminho lateral para ler a
  conversa de outro atendente.
- `conversationCount`, `proposalCount` e `lastInteractionAt` são **derivados na query**, nunca
  colunas (BUSINESS_RULES §5).
- `update` não toca em `conversations.patient_name/phone/email`: são o registro do que o canal
  informou, e continuam servindo `/conversations` até a onda que as remover (D-059).
  `phone` não é editável (chave de deduplicação).
- `document` é normalizado para 11 dígitos e tem o DV validado antes de gravar.
- `timeline` é a união de 4 origens (`conversations`, `messages`, `proposals`,
  `proposal_status_history`) ordenada por `at DESC, id DESC`, paginada com o `PaginationMeta`
  padrão. `preview` da mensagem é truncado em 160 caracteres **no SQL** (`left(content, 160)`),
  não em memória: truncar depois de trazer 50 mensagens completas é trazer o que não se usa.
- **Nascimento do paciente (D-072):** quem cria é `upsertPatientByPhone(tx, ...)`, função de
  repositório em `patient.repository.ts`, chamada por
  **`ConversationRepository.findOrCreateByPhone`** — não por este service. A chamada é sobre a
  transação **já aberta** pela conversa, porque paciente e `conversations.patient_id` precisam
  nascer no mesmo commit; um método de service abriria um segundo `withTenant`, e transação não
  aninha (D-008). Um wrapper `findOrCreateByPhone` em `PatientService`/`PatientRepository` não
  teria consumidor de produção, e por isso **não existe**.
  A corrida entre duas mensagens simultâneas do mesmo telefone morre no banco:
  ```sql
  INSERT INTO patients AS p (tenant_id, phone, name) VALUES ($1, $2, $3)
  ON CONFLICT (tenant_id, phone) DO UPDATE
    SET name = CASE WHEN p.anonymized_at IS NOT NULL THEN p.name
                    ELSE COALESCE(p.name, EXCLUDED.name) END,
        updated_at = NOW()
  RETURNING <colunas>
  ```
  O `DO UPDATE` também escreve `name`, com as três regras de D-072: nunca sobrescreve nome já
  cadastrado, preenche quando o cadastro está sem nome, e paciente anonimizado (D-063) não
  recebe nome de volta. O `RETURNING` sai do próprio `INSERT` — um `WITH ... SELECT FROM
  patients` enxergaria o snapshot anterior ao statement e não acharia a linha recém-inserida.
- `exportData` é o **único** método que ignora o recorte por papel, e por isso é `admin`:
  exportação parcial seria uma resposta errada a um pedido de titular. Registra
  `export_patient_data` no AuditService.
- `anonymize` roda tudo em **uma transação**: limpa o cadastro, troca `phone` pelo placeholder
  `'anon-' || substring(id::text, 1, 8)` (preserva `NOT NULL` e a unicidade), limpa as cópias
  denormalizadas das conversas do paciente e grava `anonymized_at`. Não apaga proposta,
  mensagem nem audit log. Registra `anonymize_patient` com o `reason` — **nunca** com os
  valores antigos.
- Depois de anonimizado, `update` lança `BusinessError('CONFLICT', { reason:
  'patient_anonymized' })`; `getById` e `exportData` continuam funcionando.
- **`inactivate`/`reactivate` (D-133, CRMLAB-11):** ao contrário de `exportData`/`anonymize`,
  **não** são `admin` — qualquer papel que enxergue o paciente aciona (mesma alçada do
  `update`). `inactivate` grava `inactivated_at`/`inactivation_reason`; `reactivate` zera os
  dois. As duas são idempotentes (`WHERE inactivated_at IS [NOT] NULL` no repositório) e só
  gravam audit log (`inactivate_patient`/`reactivate_patient`, `newValues: { reason }`) quando o
  estado de fato muda. Paciente anonimizado recebe o mesmo `CONFLICT` de `update` — reabrir um
  cadastro apagado por qualquer caminho continua proibido.
- **Exceção de ownership registrada:** `anonymize` escreve nas colunas denormalizadas de
  `conversations` — é o único caminho que faz isso. Enquanto essas colunas existirem, elas são
  cópia da identidade do paciente, e o dono da identidade é este service. Não passa pelo
  `ConversationService` porque a escrita precisa estar na mesma transação da anonimização.
- **Exceção de ownership registrada (simétrica, Onda 6):** `ConversationRepository` escreve em
  `patients` — via `upsertPatientByPhone` — e em `conversations.patient_id`, ambas colunas cujo
  dono é este service. É a contrapartida da exceção acima: a identidade do paciente e a conversa
  do canal nascem no mesmo commit, e a única forma de garantir isso com transação que não aninha
  (D-008) é a conversa chamar a função de repositório do paciente sobre a `DbTx` já aberta.
  Fora deste ponto e do `anonymize` acima, continua valendo "nenhum service acessa tabela de
  outro domínio" (Convenções Transversais).

---

## 13. ChannelSettingsService (Onda 6 — D-064/D-065/D-066)

**Responsabilidade:** canais conectados do laboratório, modo de distribuição, mensagens
automáticas e horário de atendimento. Dono de `tenant_channels` (SCHEMA.md §15) e
`tenant_settings` (§16).

```typescript
interface ChannelSettingsService {
  /** manager/admin. NUNCA devolve segredo em claro. */
  get(ctx: TenantContext): Promise<ChannelSettingsResponse>;

  /** admin. Upsert de canais por `channel` + patch parcial das configurações. */
  update(ctx: TenantContext, dto: UpdateChannelSettingsRequest): Promise<ChannelSettingsResponse>;

  /** Consumido pelo WhatsAppCredentialsResolver — fecha D-024. */
  resolveCredentials(
    tenantId: string,
    channel: ConversationChannel,
  ): Promise<{ phoneNumberId: string | null; apiToken: string | null; webhookSecret: string | null } | null>;
}
```

**Regras:**
- **Segredo nunca sai pela API.** O repositório de leitura da tela projeta colunas
  explicitamente e já devolve `apiTokenMasked` (`'••••••••' + últimos 4`) e
  `webhookSecretSet: boolean`; `SELECT *` nesta tabela devolvendo a linha ao controller é bug
  de segurança, não estilo. `resolveCredentials` é o **único** método que lê os valores em
  claro, e o retorno dele não passa por controller nenhum — só pelo adapter do canal.
- Semântica de escrita de segredo: ausente preserva · `null` apaga · string grava.
  `""` → `VALIDATION_ERROR`.
- `update` faz `INSERT ... ON CONFLICT (tenant_id, channel) DO UPDATE` por canal e
  `INSERT ... ON CONFLICT (tenant_id) DO UPDATE` em `tenant_settings`. Canal fora do array
  **não** é removido: desligar é `isActive: false`.
- `get` responde os **defaults** quando não há linha em `tenant_settings`, sem gravar (D-065).
- `businessHours` é substituído inteiro, não mesclado por dia.
- `team` sai de `users` (papéis de laboratório, ativos e inativos, `name ASC`) com o recorte
  mínimo de D-066: id, nome, papel, status — sem e-mail e sem alçada. É leitura de tabela de
  outro domínio pela **projeção mais estreita possível**; qualquer campo além destes quatro
  passa a exigir `GET /users`, que é admin.
- Auditoria: `update_channel_settings`, com `"[REDACTED]"` no lugar de qualquer segredo em
  `oldValues`/`newValues`.
- `resolveCredentials` devolve `null` quando o tenant não tem o canal configurado — o resolver
  então cai nas env vars, que é o comportamento de hoje (D-024). Isso mantém dev e CI
  funcionando sem nenhuma linha em `tenant_channels`.

---

## 14. OperationService (Onda 6 — D-067)

**Responsabilidade:** o retrato "agora" da operação para `/settings/operation`. **READ-ONLY**,
como o AnalyticsService §9.

```typescript
interface OperationService {
  /** manager/admin. Um retrato, um instante, uma query por bloco. */
  getOverview(ctx: TenantContext, query: OperationOverviewQuery): Promise<OperationOverviewResponse>;
}
```

**Regras:**
- **Nenhuma tabela nova.** Fila, carga e decisões pendentes derivam de `conversations` e
  `proposals` (BUSINESS_RULES §5). Nada é digitado, nada é materializado.
- **Sem cache.** É um painel de "agora"; o TTL de 5 min do AnalyticsService mostraria uma fila
  que já não existe. Por isso também não invalida nada.
- **Todo tempo é calculado no SQL, em UTC** (D-021):
  `EXTRACT(EPOCH FROM (NOW() - COALESCE(last_message_at, created_at)))::int`. Nenhuma subtração
  de data em JavaScript — as colunas são `TIMESTAMP` sem timezone e o driver as devolveria no
  fuso da máquina.
- `generatedAt` sai do mesmo `NOW()` das contagens, formatado como UTC no SQL.
- Definições fixas (API_CONTRACTS.md §7 traz a tabela completa): `unassigned` = ativa sem
  `assigned_to`; `waiting` = ativa, atribuída e com `unread_count > 0` — o mesmo número do
  badge do inbox, deliberadamente, para não criar uma segunda definição de "esperando".
- `workload` lista **todo** usuário ativo de papel de laboratório, zerado inclusive — some da
  tabela é pior que aparecer com zero, porque esconde quem está ocioso.
- Papel: `manager`/`admin`. Atendente → `FORBIDDEN` com
  `details.requiredRoles: ["manager","admin"]`. `denyPlatformOperator()` no router, como toda
  rota de dado de laboratório.
- **Contrato de `oldestWaitSeconds` (Onda 7, pendência mecânica):** vem de
  `MAX(CONVERSATION_WAIT) AS oldest_wait_seconds` sobre a fila **inteira** (todas as
  conversas de `QUEUE_PREDICATE`), em `operation.repository.ts#queueTotals` — **não** dos itens
  paginados por `queueLimit` (esses são uma pergunta diferente: "o topo da fila", não "a maior
  espera"). Trocar esse `MAX()` por uma leitura do primeiro item de uma lista ordenada (ex.:
  `ORDER BY waiting_seconds DESC LIMIT 1`) quebra a semântica em silêncio assim que a fila
  passar do `queueLimit`: o número devolvido vira `Math.max` só dos itens **retornados**, que só
  bate com o `MAX()` real por acidente enquanto a fila couber no limite. Qualquer mudança na
  forma de calcular `oldestWaitSeconds` tem que preservar "maior espera de TODA a fila,
  independente de paginação" e atualizar este parágrafo no mesmo commit.

---

## 15. InsuranceService (Onda 7 — D-081/D-082)

**Responsabilidade:** cadastro dos convênios do laboratório. Dono da tabela `insurances`
(SCHEMA.md §18). **Não tem método de preço** — `listPrices`/`upsertPrices` (dono de
`exam_prices`, §19) e a resolução de preço por convênio vivem no `ExamCatalogService` (§5,
`resolveActiveByIds`/`list` com `insuranceId`), porque preço é dado do catálogo, não do
convênio: o mesmo repositório que já lê `exam_catalog` faz o `LEFT JOIN`/`COALESCE` contra
`exam_prices` numa query só, sem um segundo service no meio.

```typescript
// backend/src/services/insurance.service.ts
export const MAX_PAGE = 10_000;

export interface InsuranceService {
  list(ctx: TenantContext, query: ListInsurancesQuery): Promise<ListInsurancesResponse>;
  getById(ctx: TenantContext, id: string): Promise<Insurance>;
  create(ctx: TenantContext, dto: CreateInsuranceRequest): Promise<Insurance>;   // manager/admin
  update(ctx: TenantContext, id: string, dto: UpdateInsuranceRequest): Promise<Insurance>; // manager/admin
}

export function createInsuranceService(deps: { db: DbClient; audit: AuditService }): InsuranceService;
```

**Regras:**
- `name` único por tenant → `CONFLICT` (409), mesma disciplina de `code` em `/exams`
  (verificado antes do INSERT + `isUniqueViolation` na corrida).
- Não há `DELETE`: desativar é `PATCH { isActive: false }` — propostas históricas podem
  referenciar o convênio usado (mesmo padrão de `/exams`, D-004).
- **"Particular" nunca é uma linha desta tabela** (D-082) — não existe aqui, nem em
  `exam_prices`, nenhuma entrada "Particular". Ver §5 para como o fallback é resolvido.
- `list`: `MAX_PAGE = 10_000` aplicado em `clampInt(query.page, 1, 1, MAX_PAGE)` — página acima
  do teto devolve lista vazia, não erro (mesmo padrão de `/patients`, `/proposals`).
- `create`/`update` restritos a `manager`/`admin`; auditados
  (`create_insurance`/`update_insurance`, via `audit.record(ctx, { action, entityType:
  'insurance', entityId, oldValues?, newValues? })`).
- `getById`/`update` de convênio de outro tenant → `NOT_FOUND` (nunca `FORBIDDEN`).
- Busca (`?search=`) por **nome e razão social**, mesma dobra de caixa/acento do catálogo
  (`translate` no SQL — `unaccent` indisponível no PGlite).

---

## 16. Extensões para conexão WhatsApp por QR (Onda 7 — Bloco B)

**Responsabilidade:** conectar o WhatsApp do próprio laboratório via QR code (Evolution API),
sem depender da API oficial da Meta. Estende `WhatsAppService` (§11) e `ChannelSettingsService`
(§13); nenhuma tabela nova além das colunas de `tenant_channels` (SCHEMA.md §15).

```typescript
/** Acréscimo a WhatsAppService (§11): fala com o gateway Evolution self-hosted. */
interface EvolutionWhatsAppDriver {
  /** Cria a instância no gateway se não existir (idempotente) e devolve o QR vigente. */
  connect(tenantId: string): Promise<WhatsAppQrResponse>;

  /** QR/estado atuais, sem criar nada. Usado pelo polling do frontend. */
  getQrStatus(tenantId: string): Promise<WhatsAppQrResponse>;

  /** Status do canal para o card (sem QR). */
  getStatus(tenantId: string): Promise<WhatsAppStatusResponse>;

  /** Logout da instância no gateway. */
  disconnect(tenantId: string): Promise<void>;

  /** Traduz MESSAGES_UPSERT/CONNECTION_UPDATE/QRCODE_UPDATED para os DTOs internos existentes
   * (InboundMessageDTO[]) e para os efeitos de estado do canal. Nunca lança — payload malformado
   * é ignorado por item, dentro de um try/catch por mensagem. */
  handleWebhook(payload: unknown): Promise<InboundMessageDTO[]>;
}

/** Acréscimo a ChannelSettingsService (§13): aceite do termo de risco do QR. */
interface ChannelSettingsServiceQrExtension {
  /**
   * Grava `accepted_terms_at`/`accepted_terms_by` + audit log `accept_whatsapp_qr_terms`.
   * Idempotente: reaceitar apenas atualiza o timestamp.
   */
  acceptWhatsAppQrTerms(ctx: TenantContext): Promise<void>;
}
```

**Regras:**
- **Escolha do driver por tenant** vem de `tenant_channels.connection_mode`
  (`cloud_api | qr`), resolvida no `WhatsAppCredentialsResolver` já existente (§11, D-024/D-032)
  — não um `if` espalhado pelo `WhatsAppService.send`. `connection_mode` ausente (linha antiga,
  ou tenant sem linha) = `cloud_api`, o comportamento de hoje.
- **Cada tenant = uma instância** no gateway, nomeada `tenant-<tenantId>`, com apikey e webhook
  próprios. A apikey da instância é gravada **cifrada** em `tenant_channels.api_token`
  (AES-256-GCM via `secret-box.ts`, `CHANNEL_SECRET_KEY` — a mesma infra da D-076, reusada; não
  uma segunda chave).
- **`connect` exige aceite prévio** (`accepted_terms_at` gravado) **ou** `acceptTerms: true` no
  corpo — a rota chama `acceptWhatsAppQrTerms` primeiro, então fala com o gateway. Sem os dois,
  `VALIDATION_ERROR`.
- `connect` é **idempotente**, mas o gateway **não** é: `POST /instance/create` com um nome já
  existente responde `403 "This name ... is already in use."` (verificado contra o v2.3.7). O
  cliente trata esse 403 como **adoção** — lê a apikey da instância em
  `GET /instance/fetchInstances?instanceName=` e reaplica o webhook via `POST /webhook/set/:instance`.
  Sem isso, só o primeiro pareamento de cada tenant funcionaria.
- **Registro do webhook:** a URL de callback é enviada no próprio `/instance/create` (e no
  `/webhook/set` do caminho de adoção), com header `x-evolution-webhook-token` e os eventos
  `MESSAGES_UPSERT` e `CONNECTION_UPDATE`. A base vem de **`EVOLUTION_WEBHOOK_BASE_URL`** — o
  endereço do CRM **visto de dentro do container do gateway** (`http://backend:3000` no compose;
  `http://host.docker.internal:3000` em dev com o backend no host). Não é derivável de
  `CORS_ORIGIN`, que é o endereço do navegador. Ausente ⇒ a instância é criada e o QR pareia,
  mas nenhuma mensagem entra.
- A apikey da instância vem em `hash`, que no v2.3.7 é uma **string** (`"hash": "38BD..."`); o
  formato `{apikey}` do v1 continua aceito por compatibilidade.
- **Salvaguarda anti-ban no envio:** o `EvolutionWhatsAppDriver` de envio (`send`, herdado de
  §11) aplica espaçamento mínimo configurável entre mensagens por tenant (default ~1.5s +
  jitter) na fila. **Não existe, e não entra**, nenhum endpoint de disparo em massa.
- **`EVOLUTION_API_URL`, `EVOLUTION_API_KEY` e `EVOLUTION_WEBHOOK_TOKEN` ausentes** → toda a
  superfície de QR (as 4 rotas de `/settings/channels/whatsapp/*` e o webhook) responde
  `CHANNEL_QR_UNAVAILABLE` (503 nas rotas autenticadas; o webhook — sempre `200 {received:
  true}` — apenas não processa e loga). Nunca crash no boot: a env var só é validada quando o
  caminho é exercitado.
- Webhook: autentica por **token estático** em tempo constante
  (`crypto.timingSafeEqual` contra `EVOLUTION_WEBHOOK_TOKEN`), não HMAC — o gateway Evolution
  não assina o corpo. Kill switch `is_active` verificado **antes** do token, mesma disciplina de
  D-074.
- `handleWebhook` reusa o caminho inteiro de `MessageService.createFromPatient` /
  `ConversationRepository.findOrCreateByPhone` para `MESSAGES_UPSERT` — nenhum caminho de
  ingestão paralelo. `fromMe: true` vai para `MessageService.createFromPhone` (D-173) pela
  mesma `findOrCreateByPhone`, sem `pushName` (é o nome do laboratório).
- **Grafia do evento:** o gateway v2.3.7 manda `messages.upsert`/`connection.update`
  (minúsculo, com PONTO), não o `MESSAGES_UPSERT` que este doc assumia. `normalizeEvolutionEvent`
  (`toUpperCase()` + `.` → `_`) aceita as duas em um único ponto. Sem isso a comparação exata
  nunca casava contra um gateway real e três coisas morriam juntas e em silêncio: mensagem
  recebida descartada, estado da conexão nunca gravado (o telefone exibido ficava no valor
  anterior) e a guarda de `instance` contra troca de slug virava código morto.
- **`inboundPhoneOf` decide o que vira atendimento** (`webhook.routes.ts`, ponto único):
  `fromMe: true` vira resposta do atendimento (D-173 — antes era ignorada), `@g.us` é ignorada
  (grupo não é paciente), `@lid` tira o telefone de `remoteJidAlt` (endereçamento por LID do
  WhatsApp — o LID não é discável nem casa com o cadastro) e, sem `remoteJidAlt`, a mensagem é
  descartada de propósito: uma conversa presa a um LID não tem resposta nem dedupe.
- **Instância AUSENTE no gateway (404 `does not exist`) não é erro de gateway:** `getWhatsAppQr`
  e `getWhatsAppStatus` devolvem `disconnected` e `disconnectWhatsApp` segue marcando o canal
  desconectado. Sem isso o `Error` cru do cliente subia até o error-handler e virava **500 com
  corpo vazio** — a tela de Canais travava sem oferecer reconexão, exatamente no estado em que
  reconectar é a única saída (container do gateway recriado, banco dele limpo, instância apagada
  pelo manager). Qualquer OUTRA falha do gateway continua `CHANNEL_QR_UNAVAILABLE` (503),
  traduzida por `callGateway`/`gatewayFailure` no service — o cliente HTTP nunca lança
  `BusinessError` (ver o cabeçalho de `evolution-client.ts`).
- **Versão da imagem fixada em v2.3.7** (D-083, `docker-compose.yml`/`.prod.yml`, domínio
  infra), com a linha 2.4.x como fallback documentado — este service não depende de versão
  específica, só do contrato HTTP do gateway (`/instance/*`, `/message/sendText/*`), que D-083
  documenta como estável entre as duas versões.
- **Teste:** driver e webhook cobertos por um **gateway fake** (servidor HTTP de teste que
  responde como o Evolution) — mesmo padrão do driver mock atual de `WhatsAppService`. O
  pareamento QR real com um número de verdade **não é testável em CI**; fica documentado como
  verificação manual.

### 16.1 Contrato assumido do gateway Evolution (implementação, Task 5)

O contrato acima descreve **o quê** (`connect`/`getQrStatus`/`getStatus`/`disconnect`); esta
seção registra **como** — os endpoints HTTP e os formatos de resposta que
`backend/src/lib/evolution-client.ts` assume, escritos aqui porque não estavam documentados em
lugar nenhum antes da rodada de correção da Task 5 (Minor 10 da revisão). Os dois primeiros
(`create`, `connect`) e o envio vêm do §4.2/4.3 do spec da Onda 7; os outros dois são **inferência
da Task 5** contra a superfície real da Evolution API v2 — confirmados corretos pela revisão
(caminho e verbo), mas os **formatos de resposta abaixo são suposição**, a verificar no
pareamento manual com um gateway real:

| Endpoint | Verbo | Uso | Formato assumido |
|---|---|---|---|
| `/instance/create` | `POST` | `createInstance` | `{ instance: { instanceName }, hash: { apikey } }` |
| `/instance/connect/{instance}` | `GET` | `getQr` | Pareando: `{ base64, pairingCode, code, count }` (sem `status`). Já conectada: `{ instance: { instanceName, state: "open" } }` (sem `base64`) |
| `/instance/connectionState/{instance}` | `GET` | `getStatus` | `{ instance: { instanceName, state } }`, `state ∈ {open, connecting, close}` |
| `/instance/logout/{instance}` | `DELETE` | `logout` | Corpo ignorado |
| `/message/sendText/{instance}` | `POST` | `sendText` | `{ key: { id } }` |

Autenticação: header `apikey` em **todas** as chamadas, com a apikey ADMINISTRATIVA
(`EVOLUTION_API_KEY`) — **exceto `sendText`**, que usa a apikey DA INSTÂNCIA
(resolvida por `WhatsAppCredentialsResolver`/`resolveCredentials`, D-024). Essa exceção é
deliberada (fix do Important 6 da revisão): as demais chamadas gerenciam instâncias
(`create`/`connectionState`/`logout`), o que exige privilégio administrativo; enviar uma
mensagem só precisa falar com a própria instância, e usar a chave administrativa ali era
privilégio maior que o necessário — e deixava a apikey cifrada em repouso (D-076) sem nenhum
consumidor.

**N1 da re-revisão (rodada 2): `WhatsAppCredentials.qrInstanceApiKey`, um campo SEM
fallback.** `sendText` não lê `credentials.apiToken` — esse campo cai para
`WHATSAPP_API_TOKEN` (a API OFICIAL da Meta, outro provedor) quando a linha de
`tenant_channels` não tem valor (`mergeCredentials`, `whatsapp.service.ts`), e
`connectWhatsAppQr` pode deixar a linha com `connection_mode='qr'` e `api_token` ainda `NULL`
na janela entre aceitar o termo e `createInstance` ter sucesso. `EvolutionWhatsAppDriver.send`
lê `credentials.qrInstanceApiKey`, um campo que `mergeCredentials` preenche SOMENTE a partir de
`stored?.apiToken` — nunca do fallback — e lança `EvolutionCredentialError` (tipado) quando é
`null`. Um segredo de um provedor não pode alcançar o host do outro por nenhum caminho,
inclusive um inconsistente; a checagem fica no DRIVER (o portão de última instância), não só
na ordem de escrita do service.

**`phoneNumber` é best-effort, não garantido (Minor 8 diferido).** `getStatus` lê
`instance.owner` e o webhook lê `data.owner ?? data.wuid` no evento `CONNECTION_UPDATE` — nenhum
dos dois é confirmado no formato real de resposta desses dois endpoints (o número pareado
plausivelmente só aparece em `/instance/fetchInstances`, um sexto endpoint não implementado: a
correção trocaria uma suposição não verificada por outra). Efeito conhecido: contra um gateway
real, `tenant_channels.phone_number` pode nunca ser preenchido no caminho QR, e a tela mostra o
canal conectado sem número. **Verificar no pareamento manual** e, se confirmado, abrir o sexto
endpoint como correção separada — não represada nesta rodada.

**Header do webhook de entrada:** `x-evolution-webhook-token` é o header documentado
(API_CONTRACTS.md, seção "Webhook do gateway Evolution" — infra configura o gateway para mandar
este), com `apikey` tolerado como alternativa (ruling do coordenador na revisão da Task 5,
Critical 2 — mesmo segredo, mesma comparação em tempo constante `safeEquals`, então aceitar os
dois não abre superfície nova).

**`instance` do payload é conferido contra `evolutionInstanceName(tenantId)` antes de qualquer
escrita, nas DUAS rotas que escrevem (fix do Important 4 da revisão, estendido na re-revisão).**
O `:tenant` da URL é um slug/uuid **público** e `EVOLUTION_WEBHOOK_TOKEN` é **único para a
instalação inteira** (mesmo formato de risco de D-073 emendada, §11) — sem esta checagem, quem
tivesse o token conseguia POSTar em qualquer slug e injetar mensagem/estado em outro
laboratório. A checagem mora em `instanceClaimMatches` (`webhook.routes.ts`), uma função
COMPARTILHADA pelas duas rotas que gravam em `tenant_channels`/`messages`/`conversations`:

- `evolutionInbound` (`POST /webhooks/evolution/:tenant`): `MESSAGES_UPSERT`/`CONNECTION_UPDATE`
  sem `instance` ou com `instance` que não bate com o tenant resolvido pela URL são recusados
  (`200` sem gravar nada, mesma disciplina de "nunca oráculo"). `QRCODE_UPDATED` não é escrito
  no banco e portanto não entra nesta checagem.
- `evolutionStatus` (`POST /webhooks/evolution/:tenant/status`): a re-revisão apontou que a
  rodada 1 tinha aplicado a checagem SÓ na rota principal — `/status` grava exatamente o mesmo
  efeito (`markWhatsAppConnected`/`Disconnected`) por um segundo caminho, inclusive no formato
  achatado sem envelope de evento, e um payload recusado em `/webhooks/evolution/:tenant` por
  `instance` errado passava batido só adicionando `/status` na URL. Agora `instance` é EXIGIDO
  também aqui, nos dois formatos que a rota aceita (achatado e `{event, data, instance}`) — a
  tolerância de formato (deviation 4 da revisão original) continua valendo só para a ausência do
  ENVELOPE `{event, data}`, nunca para a ausência do `instance`.

**`is_active` nunca é tocado por `disconnect`/`CONNECTION_UPDATE state:'close'` (fix do Critical
1 da revisão).** É o mesmo campo que o kill switch do webhook confere antes do token
(D-074) — zerá-lo ali travava o canal: a reconexão por QR criava instância nova, mas o
`CONNECTION_UPDATE state:'open'` seguinte batia no kill switch e nenhuma mensagem voltava a
entrar, sempre com `200 {received:true}`. Só `PATCH /settings/channels {isActive}` liga/desliga
o canal de propósito — um controle deliberadamente separado de "conectado agora"
(`connected_at`). O teste que prova esse elo (`tenant_channels.is_active` real → kill switch do
webhook) usa o resolver de PRODUÇÃO (`createTenantCredentialsResolver`) contra uma linha gravada
direto no banco — um teste que usa um resolver fake com `isActive` computado em memória, por
mais que exercite o `if` do kill switch, não prova que a COLUNA chega até ele.

**Auditoria de `disconnect_whatsapp` não afirma `isActive: false` (fix do N2 da re-revisão).**
Depois do fix do Critical 1, desconectar não muda `is_active` — um `new_values` que dissesse o
contrário registraria uma desativação que não aconteceu (Regra 7: um registro de auditoria
falso é pior que nenhum). O campo gravado agora é `{channel: 'whatsapp', connected: false}`.

---

## 17. QuickReplyService (Onda 8 §3)

Dono da tabela `quick_replies`. Serve `GET|POST /quick-replies` e
`PATCH|DELETE /quick-replies/:id` (API_CONTRACTS.md §9).

| Método | Assinatura | Regra |
|--------|-----------|-------|
| `list` | `(ctx) → ListQuickRepliesResponse` | Todas as macros do tenant, ordenadas por `shortcut`. Sem paginação (§9) |
| `create` | `(ctx, dto) → QuickReply` | Normaliza o `shortcut`, recusa duplicado, grava `created_by = ctx.userId`, audita |
| `update` | `(ctx, id, dto) → QuickReply` | Patch parcial; id de outro tenant → `NOT_FOUND`; audita só o que mudou |
| `remove` | `(ctx, id) → void` | `DELETE` real; audita com o conteúdo apagado em `oldValues` |

**Sem `assertCanWrite`.** É o único service de escrita da API que não tem um — e é
deliberado, não esquecimento: a permissão é `TENANT_ROLES`, a mesma lista que
`requireAuth() + denyPlatformOperator()` já deixa passar. Um `assertCanWrite` aqui não
recusaria ninguém que a rota já não tivesse recusado, e "confere de novo" que não pode
falhar é código que ninguém consegue testar.

**Atalho duplicado é `VALIDATION_ERROR`, não `CONFLICT`** — a divergência com
`InsuranceService` (§15) é intencional. Convênio duplicado é um estado do servidor que a
pessoa precisa investigar ("já existe esse convênio, veja a lista"); atalho duplicado é um
campo do formulário que ela corrige na hora, e o frontend precisa do `details.fields.shortcut`
para marcar o input certo. O erro carrega o mesmo shape das outras falhas de campo.

**A corrida entre o SELECT e o INSERT quem decide é o índice único** (mesma disciplina do
§15): o service tenta, e converte a violação `23505` no mesmo `VALIDATION_ERROR` que
devolveria pelo caminho feliz. Sem isso, duas atendentes criando `/coleta` ao mesmo tempo
receberiam um `DATABASE_ERROR` 500.

**Normalização do `shortcut`:** `trim()` + `toLowerCase()` antes de validar. Quem digita
`Coleta` no formulário quis dizer `coleta` — recusar por caixa alta seria rigor sem
propósito. O que a normalização **não** faz é remover acento ou espaço: `/horário coleta`
não vira `/horariocoleta` silenciosamente, porque adivinhar o atalho da pessoa produz uma
macro que ela não sabe chamar. Aí é `VALIDATION_ERROR`, e ela escolhe.

---

## 18. CommissionSettingsService (Onda 9 — D-113)

**Responsabilidade:** os 3 percentuais de comissão do laboratório. Dono das colunas
`commission_budget_pct`/`commission_exams_pct`/`commission_checkup_pct` em `tenant_settings`
(SCHEMA.md §16, ALTER da migração 012) — tabela cujo dono geral continua sendo
`ChannelSettingsService` (§13), mas as colunas de comissão são um assunto próprio (percentual de
remuneração, não configuração de canal), por isso um service pequeno e separado em vez de
inflar `ChannelSettingsService.update` com um terceiro assunto.

```typescript
export interface CommissionSettingsService {
  /** manager/admin. Defaults (2,00 / 1,50 / 1,50) quando não há linha em tenant_settings. */
  get(ctx: TenantContext): Promise<CommissionSettings>;

  /** admin. Patch parcial; upsert por tenant_id. */
  update(ctx: TenantContext, dto: UpdateCommissionSettingsRequest): Promise<CommissionSettings>;
}
```

**Regras:**
- Mesma disciplina de `tenant_settings` sem linha = defaults, sem gravar (D-065, reaproveitada):
  `get` nunca faz `INSERT`.
- `update` faz `INSERT ... ON CONFLICT (tenant_id) DO UPDATE`, exatamente como
  `ChannelSettingsService.update` já faz para `distribution_mode`/mensagens automáticas —
  mesma tabela, mesmo padrão de upsert, dois services.
- Audita `update_commission_settings` só quando algum valor muda de fato (diff-then-audit).

---

## 19. LisImportService (Onda 9 — D-109)

**Responsabilidade:** importar planilha do LIS, consolidar por número/requisição e manter o
histórico em `lis_imports`. Dono de `lis_imports` e `lis_budgets` (SCHEMA.md §25/§26).

```typescript
export interface LisImportService {
  /** manager/admin. Parseia, consolida, resolve atendente/convênio, upsert em chunks. */
  import(ctx: TenantContext, dto: ImportLisSpreadsheetRequest): Promise<LisImport>;

  /** admin. Apaga todas as linhas de lis_budgets do tenant; registra o purge no histórico. */
  purge(ctx: TenantContext, dto: PurgeLisBudgetsRequest): Promise<LisImport>;

  list(ctx: TenantContext, query: ListLisImportsQuery): Promise<ListLisImportsResponse>;

  /** Último import OU purge do tenant. null quando nunca houve um. */
  getLatest(ctx: TenantContext): Promise<LisImport | null>;
}
```

**Reaproveita de `backend/src/lib/lis-spreadsheet.ts`** (parser puro, sem I/O, sem tenant): lê o
`.xlsx` com `exceljs`, valida o guard `%PDF` e a presença da coluna `ORCAMENTO`, resolve os
aliases de coluna e converte o serial de data do Excel por componentes (sem fuso) —
BUSINESS_RULES.md §11 lista os aliases e o guard completos. O parser não fala com o banco; quem
chama (`import`) é este service.

**Regras:**
- **`consolidateByNumber`** (port do `consolidateOrcamentos` do FluxoLab): duas linhas com o
  mesmo `ORCAMENTO` na planilha viram uma só — a de maior `total_value` vence
  (BUSINESS_RULES.md §11). O mesmo vale entre planilhas diferentes: o `upsert ON CONFLICT
  (tenant_id, number) DO UPDATE` só sobrescreve quando o novo total é maior ou igual.
- **Resolução de atendente:** `attendant_name` cru da planilha (`USUÁRIO`/`USUARIO`) é casado
  contra `attendants.folded_name`; sem casar, a linha grava `attendant_name` mas
  `attendant_id NULL` — **não cria atendente automaticamente** (diferente de convênio, abaixo).
  Isso é deliberado: atendente sem cadastro prévio é sinal de erro de digitação na planilha, e
  criar um automaticamente esconderia o erro.
- **Resolução de convênio (D-114):** `principal_insurance_name` (coluna gerada, SCHEMA.md §26)
  é casado contra `insurances.name` dobrado; inexistente é **criado** com `type: 'outro'`,
  `source: 'lis'` (dentro da mesma transação do chunk). `PARTICULAR` e variantes
  (BUSINESS_RULES.md §11 lista as grafias) resolvem para `insurance_id: null`, sem criar linha.
- **Erro de arquivo é recusado ANTES de qualquer escrita** — nenhuma linha de `lis_imports` nasce
  para um arquivo que não é `.xlsx` válido, é PDF disfarçado ou não tem a coluna `ORCAMENTO`.
  `VALIDATION_ERROR` com `details.reason`.
- **Chunks:** upsert em lotes (não uma transação só para o arquivo inteiro) — planilha grande não
  deve travar tanto tempo a ponto de estourar o timeout do request; falha no meio de um chunk
  marca `lis_imports.status: "failed"` com `errorMessage`, sem reverter os chunks já commitados
  (import parcial é rastreável, `rowsAccepted` reflete o que de fato entrou).
- **Idempotência:** reimportar a mesma planilha não duplica `lis_budgets` (a chave é `(tenant_id,
  number)`) nem altera o resultado quando os totais são iguais — testável reimportando o mesmo
  arquivo duas vezes.
- **`purge`** apaga todas as linhas de `lis_budgets` do tenant e grava um `lis_imports(kind:
  'purge')` — histórico imutável do apagamento, exigido por `dto.confirm === 'LIMPAR'`
  (API_CONTRACTS.md §10.1). Nesta onda é incondicional; o bloqueio por conciliação
  (`lis_budgets.proposal_id`) é regra da Onda 13, fora deste escopo.
- Invalida `cache.delByPrefix('lis:<tenantId>:')` ao final de `import`/`purge` — a chave que
  `LisAnalyticsService` (§20) e `ExecutiveReportService` (§22) leem.
- **Entrada comum para planilha e API (CRMLAB-52, D-185 item 3):** o trecho depois do parser
  (consolidar → resolver atendente/convênio → upsert em chunks → conciliar) sai de `import` para
  `ingestRows(ctx, rows, source)`, onde `source` é `{ kind: 'import', fileName }` ou
  `{ kind: 'sync' }`. `import` = parser + `ingestRows`. `LisSyncService` (§24) chama `ingestRows`
  com as linhas já mapeadas da API. Não existe um segundo upsert.
- **Hook de conciliação por chunk (D-119 item 3b):** depois de cada chunk commitado, na mesma
  transação do chunk, `LisReconcileService.reconcileBudgets(tx, tenantId, numbers)` com os
  números daquele chunk. O total vai para `lis_imports.proposals_won`.
- **`purge` bloqueado com vínculo (D-119 item 8):** `CONFLICT lis_budgets_reconciled` se algum
  `lis_budgets.proposal_id` do tenant estiver preenchido. Checado antes de gravar o
  `lis_imports(kind: 'purge')`.

---

## 20. LisAnalyticsService (Onda 9)

**Responsabilidade:** KPIs derivados de `lis_budgets` — Resultados, Busca Ativa, filtros. **Só
leitura**, como `AnalyticsService` (§9) e `OperationService` (§14). Repositório
`lis-analytics.repository.ts` concentra o SQL (convenção do projeto: KPI é query, não
acumulado em memória — BUSINESS_RULES.md §5).

```typescript
export interface LisAnalyticsService {
  list(ctx: TenantContext, query: ListLisBudgetsQuery): Promise<ListLisBudgetsResponse>;
  getSummary(ctx: TenantContext, query: LisBudgetsSummaryQuery): Promise<LisBudgetsSummary>;
  listPending(ctx: TenantContext, query: ListPendingLisBudgetsQuery): Promise<ListPendingLisBudgetsResponse>;
  getPendingSummary(ctx: TenantContext, query: PendingLisBudgetsSummaryQuery): Promise<PendingLisBudgetsSummary>;
  getFilters(ctx: TenantContext): Promise<LisBudgetsFilters>;
}
```

**SQL em CTEs, três blocos (mesmo formato para `getSummary`, `listPending`, `getPendingSummary`
e `ExecutiveReportService`, §22 — um único texto de query reaproveitado, não reescrito por
consumidor):**
- **`issued`** — janela de **emissão**: `issued_on` dentro do período pedido.
- **`req`** — `DISTINCT ON (requisition_number) ... ORDER BY requisition_number, paid_value
  DESC`: dedupe por requisição, maior `paid_value` vence (BUSINESS_RULES.md §11) — a mesma
  requisição pode aparecer em duas linhas de `lis_budgets` (reimportação com pagamento
  atualizado), e só a de maior valor pago conta.
- **`paid`** — sobre `req`, janela de **pagamento**: `paid_on` dentro do período pedido e
  `paid_value > 0`.

**Regras:**
- **Reaproveita `toMoney`, `percent`, `average`, `resolvePeriod` de
  `backend/src/services/analytics.service.ts`** (mesmas assinaturas: `toMoney(value): number`,
  `percent(part, total): number` — `0` quando `total <= 0`, nunca `NaN`/`Infinity` —,
  `average(total, count): number`, `resolvePeriod(range, now): ResolvedPeriod`) — nenhuma
  segunda implementação de arredondamento monetário ou validação de período no domínio do LIS.
- `conversionQty = percent(paid.count, issued.count)`, **capado em 100** — dois orçamentos do
  mesmo período podem gerar uma única requisição paga, e sem o cap o percentual passaria de 100%
  (BUSINESS_RULES.md §11).
- `listPending`: `req` filtrado por `MAX(paid_value) = 0` (requisição emitida, nunca paga) e
  `days_open = CURRENT_DATE - issued_on`, recortado nas faixas `0-7`/`8-15`/`16-30`/`30+`. Sem
  fuso a considerar — `issued_on`/`paid_on` já são `DATE` (D-110).
- `byAttendant`/`byInsurance` (em `getSummary`): top 6 por valor, com **`MIN_ORC_RANKING = 20`**
  (BUSINESS_RULES.md §11) — abaixo desse número de orçamentos no período, o ranking não é
  devolvido (`[]`), porque um top-6 sobre 3 orçamentos não é informação, é ruído.
- **`getFilters`** lista só atendentes/convênios que aparecem em algum `lis_budgets` do tenant
  (`DISTINCT` sobre a FK, não o cadastro inteiro de `/attendants`/`/insurances`) — evita a tela
  oferecer um filtro que sempre devolve lista vazia.
- Cache 5 min por `(tenantId, relatório, período, filtros)`, prefixo `lis:<tenantId>:` —
  invalidado por `LisImportService.import`/`purge` (§19).

---

## 21. SalesService (Onda 9 — D-112)

**Responsabilidade:** vendas avulsas e o resumo de comissão sobre elas. Dono de `sales`
(SCHEMA.md §27).

```typescript
export interface SalesService {
  list(ctx: TenantContext, query: ListSalesQuery): Promise<ListSalesResponse>;
  create(ctx: TenantContext, dto: CreateSaleRequest): Promise<Sale>;
  remove(ctx: TenantContext, id: string): Promise<void>;
  getSummary(ctx: TenantContext, query: SalesSummaryQuery): Promise<SalesSummary>;
}
```

**Regras:**
- **Escopo por atendente, não por papel (D-112):** para `ctx.role === 'attendant'`, todo método
  resolve `attendants.id` a partir de `attendants.user_id = ctx.userId` **antes** de tocar
  `sales` — se não existir linha, `list`/`getSummary` devolvem vazio/zerado e `create` lança
  `SALE_ATTENDANT_NOT_LINKED` (403). Para `manager`/`admin`, `attendantId` vem do request/query
  e é validado contra o tenant (`NOT_FOUND` se de outro tenant ou inexistente).
- `create`: `attendantId` enviado por um `attendant` diferente do próprio é `VALIDATION_ERROR`
  — não é possível lançar venda em nome de outra pessoa por esta rota, nem o manager/admin
  "esquecendo" o campo (`attendantId` é obrigatório para eles).
- `remove`: `DELETE` real (mesma disciplina de `QuickReplyService`, §17) — venda não é
  referenciada por nenhuma outra tabela; corrigir um lançamento errado é apagar e relançar.
  Fora do recorte do atendente (venda de outro) → `NOT_FOUND`.
- **`getSummary`** agrupa por `kind` e aplica `commissionValue = toMoney(value ×
  commissionPct / 100)`, lendo os percentuais de `CommissionSettingsService.get` (§18) —
  `commission_budget_pct` nunca entra aqui (é comissão sobre orçamento conciliado, Onda 13).
  `commissionTotal` é a soma dos dois `commissionValue`, nunca um terceiro cálculo
  (BUSINESS_RULES §5/§11).

---

## 22. AttendantService (Onda 9 — D-112)

**Responsabilidade:** cadastro do atendente do LIS. Dono de `attendants` (SCHEMA.md §24).

```typescript
export interface AttendantService {
  list(ctx: TenantContext, query: ListAttendantsQuery): Promise<ListAttendantsResponse>;
  create(ctx: TenantContext, dto: CreateAttendantRequest): Promise<Attendant>;   // manager/admin
  update(ctx: TenantContext, id: string, dto: UpdateAttendantRequest): Promise<Attendant>; // manager/admin
}
```

**Regras:**
- Dedupe por `folded_name` (SCHEMA.md §24: `lower` + espaços colapsados) — `name` duplicado
  depois de dobrado é `CONFLICT` (409), mesma disciplina de `code` em `/exams` e `name` em
  `/insurances` (verificado antes do INSERT + `isUniqueViolation` na corrida).
  Acento **não** é removido — risco registrado no spec, não implementado nesta onda.
- `userId`: quando presente, precisa apontar para um `users.id` ativo do mesmo tenant com papel
  de laboratório (`attendant | manager | admin`) — `VALIDATION_ERROR` se o usuário não existir/
  estiver inativo/for `platform_operator`; `CONFLICT` se esse `userId` já estiver ligado a outro
  atendente (`UNIQUE (tenant_id, user_id)`).
- `update` com `userId: null` **desliga** o vínculo sem apagar o atendente — corrige uma ligação
  feita errado na migração do Santé (D-120) sem perder o histórico de `lis_budgets`/`sales`
  daquele atendente.
- **Sem `remove`/`DELETE`** (D-004): `lis_budgets.attendant_id` e `sales.attendant_id`
  referenciam a linha; desativação é `update(ctx, id, { isActive: false })`.
- `create`/`update` auditados (`create_attendant`/`update_attendant`).

---

## 23. ExecutiveReportService (Onda 9 — D-116)

**Responsabilidade:** o JSON único que alimenta `GET /reports/executive` e, no cliente, os dois
PDFs (Executivo e Busca Ativa) gerados com `jspdf`/`jspdf-autotable`. **Só leitura.**

```typescript
export interface ExecutiveReportService {
  getExecutiveReport(ctx: TenantContext, period: DateRange): Promise<ExecutiveReport>;
}
```

**Regras:**
- Reaproveita as MESMAS CTEs/consultas de `LisAnalyticsService.getSummary` (§20) — não uma
  segunda implementação do dedupe por requisição ou do convênio principal. A diferença para
  `/lis-budgets/summary` é a forma da resposta (`monthlySeries` de 12 meses, `brandName`/
  `logoUrl`), não a aritmética.
- `monthlySeries`: 12 meses terminando no mês de `period.endDate`, sempre 12 pontos — mês sem
  movimento entra com os dois valores em `0` (mesmo princípio de `byAgeBand`/`lossReasons`:
  série para gráfico não tem buraco).
- `brandName`/`logoUrl` vêm de `ThemeService.getCurrent` (§8) — o mesmo tema do
  `GET /themes/current` — nunca uma marca fixa (D-116, fecha o requisito de o produto servir
  qualquer tenant, não só o Laboratório Santé).
- **Não gera PDF.** `jspdf`/`jspdf-autotable` rodam no navegador (Onda 10); este service só
  devolve o JSON que os dois relatórios do cliente consomem.
- Papel: `manager`/`admin`. `denyPlatformOperator()` no router.

---

## 24. LisSyncService (CRMLAB-52 — D-185/D-186/D-187)

**Responsabilidade:** configuração e execução da sincronização dos orçamentos pela API do Bitlab.
Dono de `lis_sync_settings` (SCHEMA.md §31). Grava em `lis_budgets` **só** através de
`LisImportService.ingestRows` (§19).

```typescript
export interface LisSyncService {
  /** manager/admin. Defaults sem gravar quando não há linha. NUNCA devolve a chave. */
  getSettings(ctx: TenantContext): Promise<LisIntegrationSettings>;

  /** admin. Semântica de segredo de §13 (ausente preserva · null apaga · string grava). */
  updateSettings(ctx: TenantContext, dto: UpdateLisIntegrationRequest): Promise<LisIntegrationSettings>;

  /** manager/admin. "Sincronizar agora". CONFLICT lis_sync_running / lis_sync_not_configured. */
  runNow(ctx: TenantContext): Promise<LisSyncRunResult>;

  /** Agendador (main.ts). Lista os tenants devidos (withoutTenant, D-186) e roda um por vez. */
  runScheduledTick(): Promise<void>;
}
```

**Uma rodada** (`runForTenant(tenantId, triggeredBy: string | null)`, privado, comum a `runNow` e
ao agendador):
1. Trava em memória por tenant (`Set<string>`). Se o tenant já está rodando: `runNow` →
   `CONFLICT lis_sync_running`, e o agendador pula o tenant.
2. `withTenant`: lê `enabled`/`watermark` e `resolveApiKey` (único ponto que decifra). Grava
   `last_run_at = NOW()`.
3. Janela: `dataInicio` = `watermark` convertida para `YYYY-MM-DD HH:mm:ss` pelos componentes
   (D-187) ou, sem marca, `hoje − LIS_SYNC_INITIAL_DAYS` às 00:00:00. `dataFim` = agora, no mesmo
   formato. `tipoData: "alteracao"`.
4. Páginas: `BitlabClient.fetchBudgetsPage` com `tamanhoPagina: 500`, enquanto `temProxima` e até
   **200 páginas**. Passar do teto é falha `contract` ("mais de 100 mil orçamentos numa rodada"),
   o que protege de um `temProxima` que nunca vira `false`.
5. Todas as páginas são lidas **antes** de gravar. Se alguma falhar, nada é gravado, a marca não
   anda e a próxima rodada relê a mesma janela. O volume esperado (centenas por dia) cabe em
   memória, e o teto do item 4 limita o pior caso.
6. `received > 0`: mapeia (BUSINESS_RULES.md §11.10) e chama `LisImportService.ingestRows(ctx,
   rows, { kind: 'sync' })`, com `ctx.userId = triggeredBy`. Depois grava `watermark` = maior
   `marcaDagua` não nula das páginas, `last_success_at = NOW()` e `last_error = NULL`.
   `received = 0` só grava `last_success_at`/`last_error = NULL`.
7. Falha: `last_error` = mensagem pronta para a tela. `auth` também grava `enabled = false`
   (D-185 item 6). Log `lis_sync.failed` com `{ tenantId, kind }` e **sem** o corpo cru, porque o
   corpo pode trazer dado de paciente.
8. Libera a trava num `finally`.

**Regras:**
- `runScheduledTick` roda os tenants **em série**, não em paralelo: é um por laboratório, e
  série não compete com as requisições da tela pelo pool.
- O tique nunca lança: cada tenant tem o próprio `try/catch`. Um laboratório com erro não impede
  o próximo.
- A chave nunca é logada, nunca vai para `last_error` e nunca aparece numa mensagem de erro
  (inclusive `error.cause`).
- Auditoria: `update_lis_integration` (com `"[REDACTED]"`) e `run_lis_sync` (só no `runNow`).

### 24.1 Contrato assumido da API de Orçamentos do Bitlab (`backend/src/lib/bitlab-client.ts`)

Fonte: manual "API de Orçamentos v1 — Manual de Integração" enviado pelo Bitlab em 25/09/2026. A
chave de produção **ainda não foi exercitada**: em 25/09 ela voltou `403`. Os formatos abaixo são
os do manual. Os primeiros testes com a chave válida devem conferir cada linha desta tabela e
emendar aqui o que divergir, como foi feito com a sandbox em 18/09.

| Item | Valor |
|---|---|
| Endpoint | `POST {BITLAB_API_BASE_URL}/v1/bitlab/orcamentos` (base padrão `https://integracoes.bitlab.net.br/webhook`) |
| Auth | header `x-api-key`. Chave errada ou ausente → `403` com corpo texto `Authorization data is wrong!` (n8n, observado em 25/09) |
| Corpo | `{ dataInicio, dataFim, tipoData: "alteracao", pagina, tamanhoPagina }`. Datas `YYYY-MM-DD` ou `YYYY-MM-DD HH:mm:ss` |
| Sucesso | `200` `{ sucesso: true, apiVersao: "v1", status: "LISTA" \| "SEM_RESULTADOS", avisos: string[], filtro, paginacao: { pagina, tamanhoPagina, totalRegistros, totalPaginas, temProxima }, marcaDagua: string \| null, total, orcamentos: [] }` |
| Erro de parâmetro | `400` `{ sucesso: false, status: "PARAMETROS_INVALIDOS" \| "PERIODO_INVALIDO", erro: { codigo, mensagem } }` |
| Headers | `X-API-Version: 1.0.0`, `X-API-Deprecation: false` |

**Orçamento:** `ORCAMENTO` (number), `DATA_ORÇAMENTO` (ISO), `NM_PACIENTE`, `DT_NASCIMENTO`,
`ID_CPF`, `CONVENIO1..3` (string \| null), `VL_TOTAL1..3` (number \| null), `MEDIA_CONVENIO`,
`QTD_EXAMES`, `USUÁRIO`, `REQUISICAO` (string \| null, `posto-requisição`), `CONVENIO_REQUISICAO`,
`VALOR_REQUISICAO`, `Valor_Pago`, `Data_Pagamento` (ISO \| null), `CONTA_NULO` (0 \| 1).

**Tolerância na borda** (lições da sandbox de 18/09, `Avaliacao_APIs_Bitlab_2026-09-18.md`):
- Envelope validado com zod. Os campos que usamos são obrigatórios no schema, os desconhecidos
  são ignorados (`passthrough`). Falhou o schema → `contract`.
- Número que chegar como string numérica (`"250.00"`) é aceito. Na sandbox, `cdRequisicao` e
  `CD_SMS` vieram como string, ao contrário do PDF.
- Envelope dentro de array (`[{...}]`) é desembrulhado. O Bitlab disse ter corrigido isso em
  25/09, mas custa uma linha.
- `sucesso: false` com `200` é tratado como erro, pelo `status`. O código HTTP sozinho não basta.
- `avisos[]` não vazio ou `X-API-Deprecation: true` → log `warn` `lis_sync.bitlab_deprecation`
  (uma vez por rodada).
- Timeout de 15 s por chamada (`fetch-timeout.ts`, CRMLAB-30).
- `marcaDagua` reenviada como `dataInicio`: o manual manda usar a marca "como `dataInicio` da
  próxima carga", mas a marca vem em ISO e o `dataInicio` documentado não é ISO. Por isso ela é
  convertida pelos componentes (D-187). **Conferir no primeiro teste real** se o Bitlab compara
  `>=` ou `>` (com `>=`, o último orçamento é relido a cada rodada, o que é inofensivo porque o
  upsert é idempotente).

---

## 25. LisReconcileService (CRMLAB-52 — D-119)

**Responsabilidade:** casar `lis_budgets` com `proposals` pelo número do orçamento e aplicar as
regras de D-119. Sem rota própria: é chamado por `ProposalService.setLisReference` (§4) e pelo
hook por chunk de `LisImportService.ingestRows` (§19), sempre **dentro da transação de quem
chama**.

```typescript
export interface LisReconcileService {
  /** Os orçamentos de `numbers` que têm proposta vinculada. Devolve quantas foram a `ganho`. */
  reconcileBudgets(tx: DbTx, tenantId: string, numbers: readonly string[]): Promise<number>;
  /** Uma proposta, contra o orçamento do número dela (se já existir). true = foi a `ganho`. */
  reconcileProposal(tx: DbTx, tenantId: string, proposalId: string): Promise<boolean>;
}
```

**Regras** (D-119):
- Junção: `proposals.lis_budget_number = lis_budgets.number`, mesmo `tenant_id`. Grava
  `lis_budgets.proposal_id` e espelha em `proposals` os campos `lis_requisition_number`,
  `lis_paid_value` e `lis_paid_on`, **só quando algum mudou** (`IS DISTINCT FROM`).
- `requisition_number` preenchido + proposta não terminal → `ProposalService.markWonFromLis`, e
  grava `lis_reconciled_at`.
- `requisition_number` preenchido + proposta `perdido` → audit `lis_reconcile_conflict`
  (`entityType: "proposal"`, `newValues: { lisBudgetNumber, lisRequisitionNumber }`), uma vez
  só: não repete se `lis_requisition_number` já era o mesmo.
- Sem requisição: só espelha pagamento/valor, se houver. Status não muda.
- As emissões de WS de `markWonFromLis` são acumuladas e disparadas por quem chama **depois do
  commit**, para não anunciar um `ganho` que um rollback desfaria.

---

## Convenções Transversais

- Todo método recebe `tenantId` ou `TenantContext` como primeiro parâmetro — NUNCA lê de variável global
- Services não importam controllers; controllers não acessam repositórios
- Erros de negócio lançam exceções tipadas que o middleware converte para o formato de `API_ERRORS.md`
- Nenhum service acessa tabela de outro domínio — sempre via service dono

---

## Próximas Leituras

- `docs/api/API_CONTRACTS.md` - Endpoints que expõem estes serviços
- `docs/domain/BUSINESS_RULES.md` - Regras implementadas nos serviços
- `docs/domain/WORKFLOWS.md` - Fluxos que orquestram os serviços
