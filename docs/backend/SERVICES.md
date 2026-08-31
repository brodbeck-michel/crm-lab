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
  updateStatus(tenantId: string, id: string, status: 'active' | 'archived'): Promise<Conversation>;
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
  Funciona em conversa arquivada (o fato aconteceu) e NÃO incrementa `unread_count`
- Enviar mensagem de agente em conversa arquivada → `CONVERSATION_ARCHIVED` (409)
- `createFromPatient` incrementa `unread_count`, sobe `last_message_at` (mesma
  transação do INSERT) e é idempotente por `external_message_id` — a reentrega do
  canal não duplica mensagem nem evento

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
}
```

**Regras:**
- Canais padrão criados no onboarding: `#geral`, `#aprovacoes`
- Proposta anexada renderiza como cartão (frontend resolve via GET /proposals/:id)
- Console de plataforma tem chat PRÓPRIO, isolado (sem acesso aos canais de labs)
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
- `connect` é **idempotente**: reconectar reaproveita a instância existente no gateway
  (`POST /instance/create` seguido de `GET /instance/connect`; instância já criada não
  re-cria, só busca o QR).
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
  ingestão paralelo.
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
