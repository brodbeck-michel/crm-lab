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
  list(tenantId: string, filters: ExamFilters): Promise<Paginated<Exam>>;

  /** Ativos E inativos, na ordem dos ids pedidos. Ids desconhecidos são omitidos. */
  getByIds(tenantId: string, ids: string[]): Promise<Exam[]>;

  /** Versão estruturada de getByIds para quem precisa saber o que falhou. */
  resolveActiveByIds(tenantId: string, ids: string[]): Promise<ExamResolution>;

  create(ctx: TenantContext, dto: CreateExamRequest): Promise<Exam>;     // manager/admin
  update(ctx: TenantContext, id: string, dto: UpdateExamRequest): Promise<Exam>; // manager/admin
}

interface ExamResolution {
  found: Exam[];            // somente ATIVOS, na ordem dos ids pedidos
  byId: Map<string, Exam>;  // os mesmos de `found`, indexados
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
- Cache 1h (`EXAM_CACHE_TTL_SECONDS = 3600`), invalidado em create/update
- Busca (`?search=`) por **nome e código**, sem sensibilidade a caixa nem a acento
  (dobra via `translate` no SQL — `unaccent` não está disponível no PGlite dos testes)
- Filtros: `?active=`, `?category=` (também sem acento/caixa), `?page`/`?limit`
  (default 1/20, máx. 100), `?sortBy`/`?order` (whitelist de colunas)

**Cache — chave e invalidação:**
- Chave: `exams:<tenantId>:list:<filtros normalizados>`. O `tenantId` é o **primeiro
  segmento**: cache que vaza entre tenants é falha de isolamento igual a uma query sem
  `WHERE tenant_id`.
- Invalidação: `cache.delByPrefix('exams:<tenantId>:')` em create/update — derruba todas as
  combinações de filtro daquele tenant e de nenhum outro.

**`getByIds` / `resolveActiveByIds` NÃO passam pelo cache** — de propósito. O ProposalService
lê por aqui o preço **atual** do catálogo (BUSINESS_RULES §1, WORKFLOWS §2 passo 5); servir esse
caminho de cache arriscaria gravar uma proposta com preço obsoleto. Custo: uma query por PK.

Uso pelo ProposalService:

```typescript
const resolution = await examCatalog.resolveActiveByIds(ctx.tenantId, ids);
if (resolution.invalidIds.length > 0) {
  throw new BusinessError('EXAM_NOT_FOUND_OR_INACTIVE', { examIds: resolution.invalidIds });
}
// resolution.found / resolution.byId trazem os preços atuais
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
}
```

**Regras:**
- Canais padrão criados no onboarding: `#geral`, `#aprovacoes`
- Proposta anexada renderiza como cartão (frontend resolve via GET /proposals/:id)
- Console de plataforma tem chat PRÓPRIO, isolado (sem acesso aos canais de labs)

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
  `WhatsAppCredentialsResolver`. Enquanto não há tabela de canal no schema, o resolver
  default deriva as credenciais das env vars e a identidade do tenant do slug na URL
  do webhook (D-024); trocar por consulta a tabela é trocar a implementação do resolver
- Webhook: validar assinatura HMAC antes de processar, com `crypto.timingSafeEqual`
  (comparação de string vaza o dígito certo pelo tempo de resposta)
- Envio em fila com retry exponencial (3 tentativas) → status `failed` após esgotar.
  A fila é `src/lib/queue.ts` (`QueueService`, driver in-memory; Bull/Redis entra atrás
  da mesma interface — D-011). O relógio é injetável, então o retry é testável em
  milissegundos
- Em dev/teste: driver mock que ecoa mensagens (escolhido por `WHATSAPP_API_URL` vazia)

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
