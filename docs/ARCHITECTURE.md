# 🏗️ Arquitetura do Sistema

Visão geral técnica de como o CRM SaaS é estruturado.

**Este documento descreve o que EXISTE no código** (engenharia reversa, estado ao fim da Onda 6).
Onde houver intenção ainda não implementada, ela aparece marcada com **⚠️ NÃO IMPLEMENTADO** —
nada aqui deve ser lido como promessa implícita.

---

## Diagrama de Alto Nível

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENTE (Browser)                         │
│         React 18 + Vite + TypeScript + Tailwind 3                │
│         TanStack Query (dado de servidor) + Zustand (sessão/UI)  │
└────────────────────────────────┬────────────────────────────────┘
                                 │ HTTP + WebSocket (mesmo origin)
                                 │
┌─────────────────────────────────────────────────────────────────┐
│               NGINX da imagem do frontend (D-051)                │
│  serve o bundle estático e faz proxy de /api e /ws para a API    │
│  (HTTP em 8080; TLS/HSTS ficam no proxy de borda do host)        │
└────────────────────────────────┬────────────────────────────────┘
                                 │ REST /api/v1 + WebSocket /ws
                                 │
┌─────────────────────────────────────────────────────────────────┐
│                         BACKEND LAYER                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Node.js + Express 4 (ESM) — D-007. NÃO há NestJS.        │   │
│  │ Routers montados como `ApiModule` em src/http/modules.ts │   │
│  │ auth · users · conversations · webhooks · proposals      │   │
│  │ exams · themes · audit · analytics · internal-chat       │   │
│  │ platform · patients · settings/channels · operations     │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ BUSINESS LOGIC LAYER (src/services/)                     │   │
│  │ Auth · Conversation · Message · WhatsApp · Proposal      │   │
│  │ Approval · ExamCatalog · User · Theme · Audit            │   │
│  │ Analytics · InternalChat · Platform                      │   │
│  │ Patient · ChannelSettings · Operation      (Onda 6)      │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ DATA LAYER (src/repositories/ + src/db/)                  │   │
│  │ SQL parametrizado escrito à mão — NÃO há ORM             │   │
│  │ Dois drivers atrás de uma interface: pg / PGlite (D-008) │   │
│  │ Row-Level Security aplicada por transação                │   │
│  └──────────────────────────────────────────────────────────┘   │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                ┌────────────────┼────────────────┐
                │                │                │
                ▼                ▼                ▼
        ┌──────────────┐  ┌────────────┐  ┌──────────────────┐
        │ PostgreSQL 16│  │   Redis 7  │  │ Fila in-process  │
        │ (RLS por     │  │ (cache +   │  │ retry exponencial│
        │  tenant)     │  │ rate limit)│  │ (src/lib/queue)  │
        └──────────────┘  └────────────┘  └──────────────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │ API externa      │
                        │ - WhatsApp (Meta)│
                        └──────────────────┘
```

**⚠️ NÃO IMPLEMENTADO (intenções ainda válidas, sem código hoje):**
- **Bull/BullMQ.** `src/lib/queue.ts` é uma fila **in-process** com retry exponencial
  (3 tentativas, backoff 200ms → 30s). A interface existe justamente para Bull entrar atrás dela
  sem tocar em service nenhum (D-011).
- **Stripe / SendGrid.** Não há integração de pagamento nem de e-mail em nenhum workspace.
  A tabela de planos de `GET /platform/billing` é a constante `PLAN_CATALOG` em
  `platform.service.ts` — provisória por decisão explícita (D-019).
- **API real da Meta.** `WHATSAPP_API_URL` vazia usa `MockWhatsAppDriver`; o driver HTTP existe
  e é selecionado quando a URL está preenchida (`whatsapp.service.ts`).

---

## Padrão de Camadas

### 1. **Presentation Layer (Frontend)**
- React 18 + Vite + TypeScript + Tailwind 3 (cores mapeadas para CSS vars)
- Componentes reutilizáveis em `frontend/src/components/`; telas em `src/pages/`
- Layouts: Sidebar, Inbox (3 colunas), Orçamento (2 colunas)
- Dado de servidor **só** via TanStack Query (chaves em `src/api/query-keys.ts`);
  Zustand guarda sessão e estado de UI
- Roteamento: React Router v6, com guards por papel em `src/routes/`
- Sessão persistida em `localStorage` sob a chave `crm-lab.session`
  (`user`, `tenant`, `theme`, `tokens` — nada de dado de servidor)

### 2. **API Layer (Backend)**
- **Express 4 + TypeScript ESM** (D-007) — a alternativa NestJS foi descartada
- Prefixo único `/api/v1`; cada domínio exporta um `ApiModuleFactory`
  (`src/http/api-module.ts`) e é somado a `src/http/modules.ts`
- Ordem de middleware em `createApp` (não reordenar sem motivo):
  `helmet → cors → express.json({limit:'1mb'}) → requestContext → rateLimit →
  GET /health (público) → /api/v1/<módulos> → 404 → errorHandler`
- Controller é fino: valida o DTO com zod, chama o service, responde
- WebSocket para real-time em `src/lib/ws-hub.ts`

### 3. **Business Logic Layer**
- Services com a lógica de negócio e as regras críticas
- Cálculo de proposta, alçada, matriz de transições, derivação de tema
- `BusinessError` tipada; o middleware de erro converte para o formato de `API_ERRORS.md`

### 4. **Data Access Layer**
- **Sem ORM.** Repositórios por entidade com SQL parametrizado (`$1, $2, …`)
- Dois drivers atrás da mesma interface `DbClient` (`src/db/types.ts`):
  `pg-driver.ts` (Postgres 16) e `pglite-driver.ts` (testes, D-008)
- Migrações em `backend/migrations/*.sql`, aplicadas em ordem lexical, uma transação por
  arquivo, com o nome registrado em `schema_migrations` (tabela criada pelo runner)

### 5. **Infrastructure**
- PostgreSQL 16 e Redis 7 via `docker-compose.yml` (dev) e `docker-compose.prod.yml`
- Cache e rate limit sobre `CacheService` (Redis quando `REDIS_URL` existe; memória caso contrário)
- Autenticação JWT (access + refresh com rotação)

---

## Estratégia Multitenant

### Isolamento por Tenant

**Nível 1: Identificação**
```
JWT de acesso inclui: { userId, tenantId, role }
```
`tenantId` vem SEMPRE de `getContext(req)` — nunca de query string, body ou header.

**Nível 2: Query Filtering**
```sql
SELECT ... FROM conversations
WHERE tenant_id = $1 AND ...
```

**Nível 3: Row-Level Security (PostgreSQL)**

O backend abre cada transação com contexto de tenant e **troca de role**
(`src/db/tenant-context.ts`, chamado por `db.withTenant()`):

```ts
await tx.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
await tx.query('SET LOCAL ROLE crm_app');
```

- `set_config(..., true)` = escopo da **transação**: o valor some no COMMIT/ROLLBACK.
- `SET LOCAL ROLE crm_app` troca para uma role que **não é dona das tabelas** e não tem
  `BYPASSRLS` — sem isso as policies não valeriam. A ordem importa: o `set_config` roda como a
  role original; a troca vem depois.

As policies usam sempre a mesma forma, **fail-closed** por construção:

```sql
CREATE POLICY conversations_tenant_isolation ON conversations
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

Sem contexto de tenant a comparação vira `NULL`: nenhuma linha visível, nenhum INSERT aceito.
`FOR ALL` cobre SELECT/UPDATE/DELETE via `USING` e INSERT/UPDATE via `WITH CHECK`.
Funciona igual em Postgres 16 e em PGlite (D-008).

**Escape hatch auditado:** `db.withoutTenant()` não troca de role nem seta o GUC — roda como
dono das tabelas e portanto burla RLS. **Só dois caminhos podem usá-lo:** o login (busca o
usuário por e-mail antes de saber o tenant) e o console da plataforma (opera sobre todos os
tenants por definição). Está registrado como exceção em `src/db/types.ts`.

### Dados Isolados por Tenant

Todas as tabelas abaixo têm `tenant_id NOT NULL` e policy de RLS
(`002_row_level_security.sql` e `004_rls_onda6.sql`):

| Tabela | Migração | Origem |
|--------|----------|--------|
| `users` | 001 / RLS 002 | usuários do laboratório |
| `conversations` | 001 / RLS 002 | chats com o paciente |
| `messages` | 001 / RLS 002 | mensagens das conversas |
| `exam_catalog` | 001 / RLS 002 | catálogo de exames (**o nome não é `exams`**) |
| `proposals` | 001 / RLS 002 | orçamentos |
| `proposal_items` | 001 / RLS 002 | itens (tenant_id próprio, D-002) |
| `proposal_status_history` | 001 / RLS 002 | histórico de estágio |
| `themes` | 001 / RLS 002 | personalização visual (1:1 por `tenant_id UNIQUE`) |
| `audit_logs` | 001 / RLS 002 | **auditoria — é por tenant, não compartilhada** |
| `internal_channels` | 001 / RLS 002 | chat interno |
| `internal_messages` | 001 / RLS 002 | chat interno |
| `refresh_tokens` | 001 / RLS 002 | sessões |
| `patients` | 003 / RLS 004 | ficha do paciente (Onda 6, D-059) |
| `tenant_channels` | 003 / RLS 004 | credenciais de canal por laboratório (D-064) |
| `tenant_settings` | 003 / RLS 004 | distribuição, automáticas, horário (D-065) |
| `channel_reads` | 003 / RLS 004 | leitura de canal interno (D-068) |

`tenants` é a tabela raiz: não tem coluna `tenant_id`, mas **também está sob RLS**, com policy
pela própria coluna `id` (`tenants_self_isolation`). Sem ela, qualquer caminho que esquecesse o
filtro enumeraria todos os laboratórios clientes.

> **Tabela nova sem policy não trava — ela VAZA.** O `ALTER DEFAULT PRIVILEGES` da migração 002
> já concede SELECT/INSERT/UPDATE/DELETE a `crm_app` no momento do `CREATE TABLE`. Por isso a
> migração 004 existe: toda tabela nova precisa da sua policy no mesmo par de migrações.

### Dados Compartilhados (Plataforma)

**Só existe uma tabela fora do isolamento por tenant:** `schema_migrations`, criada pelo runner
de migrações para registrar o que já foi aplicado. Não contém dado de laboratório.

Correções de fatos que este documento afirmava e são **falsos**:
- `audit_logs` **não** é compartilhado entre tenants. Tem `tenant_id NOT NULL` e policy de RLS
  desde a migração 002.
- `subscriptions` e `feature_flags` **nunca existiram** no schema — não há `CREATE TABLE` para
  nenhuma das duas em `backend/migrations/`. Faturamento é derivado em tempo de leitura pelo
  `PlatformService` a partir de `tenants` + contagem de mensagens (D-019), e não há mecanismo de
  feature flag no projeto.

O console da plataforma (papel `platform_operator`, em `users.role`) enxerga vários tenants
apenas pelo `withoutTenant()` descrito acima. Todo router que serve dado de laboratório usa
`denyPlatformOperator()`.

---

## Fluxo de Autenticação

```
┌────────────┐
│  Login UI  │
└─────┬──────┘
      │ email + password
      ▼
┌──────────────────────────────────────────────┐
│ POST /api/v1/auth/login                      │
├──────────────────────────────────────────────┤
│ 1. withoutTenant(): achar o usuário por email │
│ 2. bcrypt.compare da senha                    │
│ 3. Assinar access (JWT_ACCESS_TTL = 900s)     │
│ 4. Assinar refresh (JWT_REFRESH_TTL = 7d)     │
│    com claims { userId, tenantId, role, jti } │
│ 5. Guardar o HASH do refresh em refresh_tokens│
└─────┬────────────────────────────────────────┘
      │ { accessToken, refreshToken, user, tenant (com theme) }
      ▼
┌──────────────────────────────────────────────┐
│ Zustand persist → localStorage                │
│   chave "crm-lab.session"                     │
└─────┬────────────────────────────────────────┘
      │ Authorization: Bearer <accessToken>
      ▼
┌──────────────────────────────────────────────┐
│ requireAuth() (por rota, não global)          │
├──────────────────────────────────────────────┤
│ 1. Verificar assinatura e expiração do JWT    │
│ 2. Extrair userId / tenantId / role           │
│ 3. Popular req.ctx (TenantContext)            │
│ 4. requireRoles() / denyPlatformOperator()    │
└──────────────────────────────────────────────┘
```

**Rotação de refresh (D-014).** `POST /auth/refresh` devolve um `refreshToken` **novo** e revoga
o anterior na mesma transação. `RefreshResponse.refreshToken` é obrigatório no contrato (D-053):
o cliente que não substituir o token guardado perde a sessão.

**Detecção de reuso (D-015).** Apresentar um refresh **já revogado** é tratado como roubo:
o AuthService revoga *todos* os tokens vivos do usuário (`revokeAllForUser`) e grava um audit log
`refresh_token_reuse_detected` com a quantidade revogada. Limitação registrada em `STATUS.md`:
não há coluna `family_id`, então o escopo é o usuário inteiro — mais amplo que o necessário,
porém correto.

**O refresh token viaja no corpo, não em cookie.** Não há cookie de sessão no projeto — ver a
seção Segurança.

---

## Fluxo de Dados: Conversa → Proposta

```
1. Paciente envia mensagem (WhatsApp)
   ↓
2. POST /api/v1/webhooks/whatsapp/<slug do tenant>
   - a IDENTIDADE do tenant vem do slug/uuid da URL
   - a CREDENCIAL (inclusive o segredo do HMAC) vem de `tenant_channels`,
     com fallback campo a campo para env var (D-024 / D-073)
   - HMAC verificado com `timingSafeEqual` ANTES de qualquer processamento;
     assinatura inválida → 200 vazio e nada toca o banco
   ↓
3. ConversationService/MessageService
   - abre ou reaproveita a conversa; a conversa nasce já ligada ao paciente
     (`conversations.patient_id`, D-059/D-072 — nome do canal preenche, nunca sobrescreve)
   - grava a message, sobe `last_message_at`, incrementa `unread_count`
   - emite WebSocket `conversation.new_message` para o tenant
   ↓
4. Frontend recebe em tempo real e invalida as chaves do TanStack Query
   ↓
5. Atendente monta o orçamento e chama POST /api/v1/proposals
   ↓
6. ProposalService.create()
   - o cliente manda só { conversationId, items[{examId, quantity}], discountPercent? };
     o DTO é `.strict()` — mandar `totalPrice` dá VALIDATION_ERROR (BUSINESS_RULES §1)
   - preços vêm do catálogo NO MOMENTO da criação (`resolveActiveByIds`, sem cache)
   - total calculado no backend; alçada validada no backend
   - nasce em `novo_contato` e grava a 1ª linha de `proposal_status_history`
   ↓
7. Se o desconto excede a alçada: NÃO é 403.
   - responde 201 com `approvalStatus: "pending"` (D-045)
   - ApprovalService cria o pedido, posta em #aprovacoes (chat interno)
     e emite `approval.requested`
   - dentro da alçada, a proposta nasce `approvalStatus: "approved"` (D-048)
   ↓
8. PATCH /proposals/:id/status percorre a matriz `ALLOWED_TRANSITIONS`
   - `orcamento_enviado` e `ganho` gravam mensagem de sistema na conversa
   - estágio terminal grava `closed_at`; `perdido` exige `reasonLost` válido
   - emite `proposal.status_changed`
```

**Correção de fato:** o passo "a conversa passa para o estágio `orcamento_enviado`" não existe.
`conversations.status` só assume `active | archived | closed`; os estágios do funil
(`novo_contato → orcamento_enviado → follow_up → negociacao → ganho | perdido`) são de
**proposals**, não de conversas.

---

## Contrato Frontend ↔ Backend

A fonte da verdade é `docs/api/API_CONTRACTS.md` (e `shared/types/`, que a espelha).
`docs/contracts/FRONTEND_BACKEND.md` traz o mesmo recorte pelo lado do cliente.

**Regra de envelope (D-070) — três formas, sem quarta:**
1. **Listagem:** chave nomeada no plural + `pagination` (D-009)
2. **Recurso único** (GET, POST ou PATCH): o objeto **cru**, sem envelope
3. **Resposta composta:** uma chave por parte. Sem corpo: `204`

Exceções explícitas registradas em `API_CONTRACTS.md`: `GET`/`PATCH /themes/current` (`{ theme }`),
as projeções parciais de `PATCH /proposals/:id/{status,discount,approve,reject}` e o ACK
`{ received: true }` do webhook. Fora dessas linhas, envelope de recurso único é bug de contrato.

**Exemplos reais (conferidos no controller, não no que se supunha):**

| Endpoint | Resposta de verdade |
|----------|---------------------|
| `GET /conversations` | `{ conversations: Conversation[], pagination, counts: { mine, unassigned } }` — **não** `totalCount`/`unreadCount`. Os `counts` alimentam os chips e **não** mudam com `?scope=` |
| `GET /conversations/:id` | `{ conversation, messages, pagination }` — e este GET **marca a conversa como lida** (D-027) |
| `GET /proposals/:id` | `ProposalDetail` **cru** (items, subtotal, history, approvals embutidos) — não `{ proposal, history, approvals }` |
| `PATCH /proposals/:id/status` | projeção parcial `{ id, status, reasonLost, updatedAt }` |
| `PATCH /proposals/:id/discount` | projeção parcial `{ id, discountPercent, totalPrice }` |
| `PATCH /proposals/:id/approve` e `/reject` | `{ id, approvalStatus, approvedAt }` — o campo `message` em pt-BR **foi removido na Onda 6** (D-070): texto de interface é do frontend (i18n) |

---

## Padrão de Erro Padronizado

Todos os erros seguem este formato:

```json
{
  "error": {
    "code": "PROPOSAL_EXCEEDS_DISCOUNT_LIMIT",
    "message": "Desconto solicitado excede alçada do usuário",
    "statusCode": 403,
    "details": {
      "requestedDiscount": 25,
      "userLimit": 15,
      "approvalRequired": true
    }
  }
}
```

O backend lança `BusinessError` tipada (`src/http/errors.ts`) e o `errorHandler` — sempre o
último middleware — faz a conversão. **Recurso de outro tenant responde `NOT_FOUND`, nunca
`FORBIDDEN`.** Ver `docs/api/API_ERRORS.md` para o catálogo (`ApiErrorCode` em `shared/types/`).

---

## Performance & Escalabilidade

### Caching Strategy

`CacheService` é uma interface com duas implementações (`src/lib/cache.ts`, D-011):
`RedisCache` (ioredis) quando `REDIS_URL` está setada, `MemoryCache` in-process caso contrário.
**Desde D-058 o Redis é real e o boot é fail-closed:** `main.ts` chama `verifyCacheReady(cache)`
antes de subir — Redis configurado que não responde derruba o processo em vez de degradar em
silêncio.

| O quê | Onde | TTL |
|-------|------|-----|
| Catálogo de exames | `CacheService` | 3600s (`EXAM_CACHE_TTL_SECONDS`) |
| Analytics | `CacheService` | 300s (`ANALYTICS_CACHE_TTL_SECONDS`) |
| Janela do rate limit | `CacheService` | 60s |
| Listas do frontend | TanStack Query | por chave, em `src/api/query-keys.ts` |

Preço **nunca** sai do cache: `getByIds`/`resolveActiveByIds` leem sempre o banco, para que uma
proposta não nasça com preço obsoleto. Mutação de proposta invalida o cache de analytics do
tenant inteiro (D-055). Cálculo de proposta não é cacheado — é feito na hora, no backend.

### Database Optimization
- Índices em `tenant_id` de todas as tabelas de laboratório, além de `user_id`,
  `conversation_id`, `proposal_id`, `created_at`, `expires_at`
- Conexão fixada em `TimeZone=UTC` e aritmética de tempo explícita em UTC (D-078/D-021):
  `TIMESTAMP` sem timezone voltava do driver interpretado no fuso da máquina
- **⚠️ NÃO IMPLEMENTADO:** particionamento por tenant e timeouts de query configurados
  (5s leitura / 10s escrita). Intenção válida, sem código hoje.

### WebSocket Events (Real-time)

Contrato em `shared/types/websocket.types.ts`; hub em `src/lib/ws-hub.ts`, com
`emitToTenant` e `emitToUser`.

| Evento | Emitido por | Alcance |
|--------|-------------|---------|
| `conversation.new_message` | MessageService | tenant |
| `proposal.status_changed` | ProposalService | tenant |
| `approval.requested` | ApprovalService | tenant |
| `approval.decided` | ApprovalService | usuário que criou a proposta |
| `internal_chat.new_message` | InternalChatService | tenant |
| `user.came_online` | **⚠️ NÃO IMPLEMENTADO** — declarado no tipo e tratado no cliente (`frontend/src/api/ws.ts`), mas nenhum service o emite | — |

---

## Segurança

### Camadas de Proteção (o que existe)

1. **`helmet()`** com defaults, e `x-powered-by` desabilitado
2. **CORS** por lista de origens (`CORS_ORIGIN`, separada por vírgula; default
   `http://localhost:5173`), `credentials: false`
3. **JWT com expiração** — access 900s (`JWT_ACCESS_TTL`), refresh 7 dias
   (`JWT_REFRESH_TTL`), segredos separados para os dois
4. **Refresh guardado hasheado** em `refresh_tokens`, com rotação (D-014) e detecção de
   reuso (D-015)
5. **Senha com bcrypt** (`bcryptjs`)
6. **SQL parametrizado** em todos os repositórios (não há ORM), mais RLS como segunda barreira
7. **Rate limiting** (`RATE_LIMIT_PER_MINUTE`, default 100/min) sobre `CacheService` — janela
   deslizante. A chave **verifica a assinatura do Bearer token e limita por usuário**;
   rota pública (login, refresh, webhook) e token inválido caem no balde por IP (D-054)
8. **Lockout de login**: 5 tentativas falhas por `email+IP` em 15 min
   (`LOGIN_FAILURE_LIMIT` / `LOGIN_FAILURE_WINDOW_SECONDS`, contadas no `CacheService` dentro do
   `AuthService`), com `retryAfter` na resposta
9. **IP confiável** (D-057): `trust proxy` sai de `TRUSTED_PROXIES`/`TRUST_PROXY_HOPS`, com
   default `false`. Sem configuração explícita, `X-Forwarded-For` é ignorado — o header alimenta
   rate limit, lockout de login e `ip_address` do audit log
10. **Webhook**: HMAC comparado com `crypto.timingSafeEqual`; assinatura inválida devolve 200
   vazio e não toca o banco (sem oráculo)
11. **Credencial de canal cifrada em repouso** (D-076): AES-256-GCM sobre
    `tenant_channels.api_token` e `webhook_secret`, com a chave em `CHANNEL_SECRET_KEY` —
    obrigatória, com ≥32 caracteres e diferente do valor de exemplo em `NODE_ENV=production`
12. **XSS**: escape padrão do React (não há `dangerouslySetInnerHTML` nas telas)
13. **Auditoria**: proposta, aprovação e permissão geram `audit_logs`; o `AuditService` nunca
    lança (falhas ficam em `audit.failures`)
14. **LGPD** (D-063 emendada por D-075): `POST /patients/:id/anonymize` é anonimização, não
    `DELETE`. Alcança cadastro, colunas denormalizadas de `conversations`,
    `messages.attachment_url` e os **valores** do audit log (substituídos por `"[ERASED]"`,
    preservando linha, ação, autor, timestamp e chaves). **Limitação declarada:** o TEXTO das
    mensagens não é reescrito

**⚠️ NÃO IMPLEMENTADO:**
- **CSRF via SameSite cookies.** Não há cookie de sessão: os tokens viajam no corpo e no header
  `Authorization`, e a sessão fica em `localStorage`. Não há vetor de CSRF por cookie e também
  não há proteção de CSRF — a afirmação anterior deste doc descrevia um mecanismo inexistente.
- **HTTPS obrigatório na aplicação.** O nginx da imagem serve HTTP em 8080; TLS/HSTS são
  responsabilidade do proxy de borda do host (registrado em `DEPLOYMENT.md` §7).
- **Criptografia em repouso do banco.** Senhas são *hasheadas* e refresh tokens também; a
  cifra em repouso existe só para as credenciais de canal (item 10). Não há criptografia de
  disco/coluna gerenciada pela aplicação.
- **CORS por tenant.** A lista de origens é global.

Ver `docs/architecture/SECURITY.md` para detalhes.

---

## Deployment Architecture

O que o pipeline **faz hoje** (`.github/workflows/ci.yml`, quatro jobs):

```
┌─────────────────────┐
│  Push / Pull Request│
└──────────┬──────────┘
           ▼
┌───────────────────────────────────┐
│ job `quality`                     │
│ - typecheck (4 workspaces)        │
│ - lint                            │
│ - testes de backend e de frontend │
└──────────┬────────────────────────┘
           ▼
┌───────────────────────────────────┐
│ job `build`                       │
│ - build shared/backend/frontend   │
│ - verifica artefatos e publica    │
└──────────┬────────────────────────┘
           ▼
┌───────────────────────────────────┐
│ job `docker`                      │
│ - constrói as duas imagens        │
│ - smoke test das imagens          │
│ - NÃO faz push (sem registry)     │
└──────────┬────────────────────────┘
           ▼
┌───────────────────────────────────┐
│ job `e2e` (Playwright)            │
│ - migra + semeia dataset fixo     │
│ - sobe API e UI, roda a suíte     │
│ - sem `continue-on-error` (D-052) │
└───────────────────────────────────┘
```

Deploy é **manual**, documentado passo a passo em `docs/guides/DEPLOYMENT.md` §4
(build das imagens → migração SEMPRE antes de subir → `docker-compose.prod.yml` → conferência),
com procedimento de rollback em §5.

**⚠️ NÃO IMPLEMENTADO** (a lista canônica é `DEPLOYMENT.md` §7):
- push de imagem para registry e deploy automático (não há registry definido)
- ambiente de **staging** (não há host definido)
- **aprovação manual** como gate do pipeline
- **blue-green** e health check de deploy
- certificado TLS no pipeline

---

## Próximas Leituras

- `docs/database/SCHEMA.md` — o banco, tabela a tabela
- `docs/api/API_CONTRACTS.md` — endpoints e shapes
- `docs/backend/SERVICES.md` — responsabilidade de cada service
- `docs/architecture/SECURITY.md` — segurança em detalhes
- `docs/DECISIONS.md` — por que cada escolha foi feita
- `docs/guides/DEPLOYMENT.md` — pipeline, imagens e rollback

> A antiga entrada `docs/architecture/MULTITENANT.md` foi removida desta lista: o arquivo não
> existe. O conteúdo equivalente está na seção "Estratégia Multitenant" acima e em
> `BUSINESS_RULES.md` §4.
