# 🔌 Contratos de API (REST)

Especificação completa de todos os endpoints que o backend deve implementar.

---

## Base URL

```
Development: http://localhost:3000/api/v1
Production: https://api.crm-lab.com/api/v1
```

## Authentication

Todos os endpoints (exceto `/auth/login` e `/auth/register`) requerem:

```
Authorization: Bearer <JWT_TOKEN>
```

JWT inclui: `{ userId, tenantId, role, exp }`

---

## 1. Authentication & Users

### POST /auth/login
Fazer login.

**Request:**
```json
{
  "email": "user@lab.com",
  "password": "senha123"
}
```

**Response (200):**
```json
{
  "accessToken": "eyJhbGc...",
  "refreshToken": "eyJhbGc...",
  "expiresIn": 900,
  "user": {
    "id": "uuid",
    "email": "user@lab.com",
    "name": "João Silva",
    "role": "attendant",
    "discountLimit": 15
  },
  "tenant": {
    "id": "uuid",
    "name": "Lab Exemplo",
    "slug": "lab-exemplo",
    "theme": { "accent": "#c67139", ... }
  }
}
```

### POST /auth/refresh
Renovar access token usando refresh token.

**Request:**
```json
{
  "refreshToken": "eyJhbGc..."
}
```

**Response (200):**
```json
{
  "accessToken": "eyJhbGc...",
  "expiresIn": 900,
  "refreshToken": "eyJhbGc..."
}
```

O refresh token é **rotacionado a cada uso** (SECURITY.md): a chamada revoga o token
enviado e emite um novo, devolvido em `refreshToken` (D-014). O cliente DEVE substituir
o token guardado. Reusar um refresh já rotacionado é tratado como roubo: devolve
`REFRESH_TOKEN_INVALID` e revoga toda a família de tokens do usuário (D-015).

`RefreshResponse` em `shared/types/auth.types.ts` declara os três campos, `refreshToken`
**obrigatório** — a rotação é incondicional, então um campo opcional descreveria uma
resposta que não existe (D-053). A divergência aberta na Onda 5 está fechada: não há mais
tipo local no `auth.service`.

**Erros:** `REFRESH_TOKEN_INVALID` (401), `USER_INACTIVE` (403), `TENANT_INACTIVE` (403)

### POST /auth/logout
Fazer logout (invalidar refresh token).

**Request:**
```json
{
  "refreshToken": "eyJhbGc..."
}
```

**Response (200):**
```json
{
  "message": "Logged out successfully"
}
```

Idempotente: token desconhecido ou já revogado devolve a mesma resposta (não é oráculo).

### GET /users/me
Informações do usuário logado.

**Response (200):**
```json
{
  "id": "uuid",
  "email": "user@lab.com",
  "name": "João Silva",
  "role": "attendant",
  "discountLimit": 15,
  "createdAt": "2024-08-20T10:30:00Z"
}
```

Shape: `CurrentUserResponse` (`shared/types/auth.types.ts`) — **sem** `isActive` e
`lastLoginAt`, que são exclusivos de `ManagedUser`. Qualquer papel de laboratório
acessa; `platform_operator` recebe `403` (o console não tem caminho para `/users`).

**Erros:** `NOT_FOUND` (404 — token ainda válido de usuário já removido),
`FORBIDDEN` (403, `platform_operator`)

### GET /users (admin apenas)
Tabela da tela `/settings/users`.

**Query Params:**
```
?page=1&limit=20        (limit máx. 100)
?search=joão            (nome OU e-mail, `ILIKE %termo%`)
?isActive=true
```

Ordenação fixa por `name ASC` — não há `sortBy` nesta rota.

**Response (200):**
```json
{
  "users": [
    {
      "id": "uuid",
      "email": "user@lab.com",
      "name": "João Silva",
      "role": "attendant",
      "discountLimit": 15,
      "isActive": true,
      "lastLoginAt": "2024-08-23T09:12:00Z",
      "createdAt": "2024-08-20T10:30:00Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 3, "totalPages": 1 }
}
```

**Erros:** `FORBIDDEN` (403, `details.requiredRoles: ["admin"]`)

### POST /users (admin apenas)
Criar usuário no próprio tenant.

**Request:**
```json
{
  "email": "novo@lab.com",
  "name": "Nova Gestora",
  "password": "senha-forte-123",
  "role": "manager",
  "discountLimit": 30
}
```

- `role` ∈ `attendant | manager | admin`. `platform_operator` NÃO é atribuível aqui
  (pertence ao console da plataforma) → `VALIDATION_ERROR`.
- `discountLimit` é opcional: o default vem de `DEFAULT_DISCOUNT_LIMIT[role]`
  (`@crm-lab/shared`, BUSINESS_RULES §2).
- `password`: mínimo 8 caracteres (SECURITY.md).
- `name`: 2..255 caracteres. `discountLimit`: inteiro de 0 a 100.
- O e-mail é normalizado (trim + minúsculas) antes de gravar.
- Criação gera audit log `create_user`.

**Response (201):** o `ManagedUser` criado **sem envelope** (mesmo shape dos itens de
`GET /users`; `lastLoginAt` nasce `null`).

**Erros:** `VALIDATION_ERROR` (400, `details.fields`), `FORBIDDEN` (403,
`details.requiredRoles: ["admin"]`), `CONFLICT` (409, e-mail já usado no tenant —
`details.field: "email"`)

### PATCH /users/:id (admin apenas)
Editar papel, alçada, nome ou status. **Não existe DELETE**: desativa-se com
`isActive: false` (o histórico de propostas referencia o usuário).

**Request:** (todos os campos opcionais, ao menos um)
```json
{
  "name": "João Silva",
  "role": "manager",
  "discountLimit": 30,
  "isActive": true
}
```

Mudança de `role`, `discountLimit` ou `isActive` gera audit log
(`update_user_permissions`). Ninguém altera o próprio papel, a própria alçada ou o
próprio status — nem o admin (D-013) → `FORBIDDEN` com
`details.reason: "self_privilege_change"` e `details.fields: ["role", ...]` (os campos
que o usuário tentou mudar em si mesmo). Renomear-se a si próprio é permitido e **não**
gera audit log: só papel, alçada e status geram — e só quando o valor de fato mudou.

**Response (200):** o `ManagedUser` atualizado, **sem envelope**.

**Erros:** `VALIDATION_ERROR` (400), `FORBIDDEN` (403), `NOT_FOUND` (404 — inexistente
**ou de outro tenant**; nunca 403, para não vazar existência)

---

## 1b. Themes (Personalização)

Tela `/settings/theme`. D-005: o backend guarda **só** as 5 cores base + `radiusId` +
`fontId` + brand; as 27 variações são derivadas no frontend por `color-mix(in oklab)`.

Leitura (`GET /themes/current`, `GET /themes/presets`) é aberta a **qualquer usuário
autenticado do laboratório** — o preview da tela precisa dos presets. Só o `PATCH` é
admin. `platform_operator` recebe `403` em toda a seção.

### GET /themes/current
Tema do tenant logado. Tenant sem personalização recebe o tema padrão (preset
`terracota`, `fontId: "figtree"`, `radiusId: "suave"`).

**Response (200):**
```json
{
  "theme": {
    "accent": "#c67139",
    "accent2": "#7a8a5e",
    "bg": "#f5ead8",
    "surface": "#ebddc5",
    "text": "#1a1a1a",
    "fontId": "figtree",
    "radiusId": "suave",
    "brandName": null,
    "logoUrl": null
  }
}
```

O mesmo objeto viaja em `tenant.theme` na resposta de `POST /auth/login` — o frontend
não faz request extra no bootstrap.

### PATCH /themes/current (admin apenas)
Salvar personalização. PATCH parcial: campo não enviado permanece.

**Request:** (todos opcionais, ao menos um)
```json
{
  "accent": "#2f6f9f",
  "accent2": "#4f9d8b",
  "bg": "#eef3f7",
  "surface": "#dbe6ef",
  "text": "#1a1a1a",
  "fontId": "playfair",
  "radiusId": "redondo",
  "brandName": "Lab Azul",
  "logoUrl": null
}
```

- Cores: `#rrggbb` exato (6 dígitos, forma curta recusada) → `VALIDATION_ERROR` com
  `details.fields`
- `radiusId` ∈ `reto | suave | redondo`; `fontId` ∈ `figtree | playfair | system`
- `brandName` máx. 255, `logoUrl` máx. 500 — ambos anuláveis. Enviar `null` **apaga**
  o valor; omitir o campo o preserva (essa é a diferença entre `null` e ausente)
- Corpo vazio (`{}`) ou campo desconhecido → `VALIDATION_ERROR` (o schema é `strict`)

**Response (200):** `{ "theme": { ... } }` — o tema salvo. Gera audit log `update_theme`.

**Erros:** `VALIDATION_ERROR` (400), `FORBIDDEN` (403, não-admin)

### GET /themes/presets
Os 5 temas prontos de `docs/design/DESIGN_TOKENS.md`. Estático — não toca o banco.

**Response (200):**
```json
{
  "presets": [
    {
      "id": "terracota",
      "name": "Terracota & Sálvia",
      "accent": "#c67139",
      "accent2": "#7a8a5e",
      "bg": "#f5ead8",
      "surface": "#ebddc5",
      "text": "#1a1a1a"
    }
  ]
}
```

Ordem e nomes, exatamente como saem do backend:

| id | name |
|---|---|
| `terracota` | Terracota & Sálvia |
| `jaleco` | Azul Jaleco |
| `esteril` | Verde Esterilizado |
| `hemograma` | Hemograma |
| `diagnostico` | Lilás Diagnóstico |

O preset **não** carrega `fontId`/`radiusId`/brand (`ThemePreset` = id + name + as 5
cores): aplicar um preset troca só as cores. O primeiro item é a origem do tema padrão
de `GET /themes/current`.

---

## 1c. Audit Log

### GET /audit (admin apenas)
Aba "Log de auditoria" da tela `/settings/users`. **Append-only**: não existe POST,
PATCH nem DELETE de audit log (SECURITY.md — logs nunca são editáveis via API).

**Query Params:**
```
?page=1&limit=20       (limit máx. 100)
?action=update_user_permissions    (máx. 100 caracteres, casamento exato)
?entityType=proposal               (máx. 50 caracteres, casamento exato)
?entityId=<uuid>                   (uuid — outro formato é VALIDATION_ERROR)
?userId=<uuid>                     (uuid)
?order=asc|desc        (default: desc, por timestamp; desempate pelo id)
```

**Response (200):**
```json
{
  "entries": [
    {
      "id": "uuid",
      "userId": "uuid",
      "userName": "Admin A",
      "action": "update_user_permissions",
      "entityType": "user",
      "entityId": "uuid",
      "oldValues": { "role": "attendant", "discountLimit": 15 },
      "newValues": { "role": "manager", "discountLimit": 30 },
      "ipAddress": "10.0.0.1",
      "timestamp": "2026-08-23T17:31:00Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

`userId`, `userName`, `oldValues`, `newValues` e `ipAddress` são **anuláveis**
(`AuditEntry` em `shared/types/audit.types.ts`): ação de sistema não tem autor, e
criação não tem `oldValues`.

Ações registradas hoje: `login`, `logout`, `refresh_token_reuse_detected`, `create_user`,
`update_user_permissions`, `update_theme`, `create_conversation`, `assign_conversation`,
`update_conversation_status`, `create_proposal`, `update_proposal_status`,
`update_proposal_discount`, `approve_discount`, `reject_discount` e `create_tenant`
(este último nasce no console e é gravado sob o tenant do **operador**, não sob o
laboratório recém-criado — logo não aparece no `/audit` do lab novo).
`action` é `string` livre no tipo — não há enum fechado. Entrada de outro tenant nunca
aparece (RLS).

**Erros:** `FORBIDDEN` (403, `details.requiredRoles: ["admin"]`)

---

## 2. Conversations (Chats)

### GET /conversations
Listar conversas do usuário.

**Recorte por papel (não é filtro opcional):** atendente recebe apenas as conversas
atribuídas a ele **mais** a fila não atribuída; gestor e admin recebem todas as do
laboratório. `platform_operator` recebe `FORBIDDEN` (PAGES.md §11).

**Query Params:**
```
?status=active|archived|closed
?scope=mine|unassigned|all        # default: all — os chips da coluna 1
?page=1&limit=20                  # limit máx. 100
?search=joão                      # máx. 120 caracteres
?sortBy=lastMessageAt|createdAt|unreadCount|patientName&order=desc
```

`sortBy` default `lastMessageAt`, `order` default `desc` (qualquer valor diferente de
`asc` cai no default). `search` casa busca textual no nome do paciente (full-text
`portuguese`) **OU** o telefone: o termo é reduzido a dígitos e só entra na busca por
telefone quando sobram **3 dígitos ou mais**.

**Response (200):**
```json
{
  "conversations": [
    {
      "id": "uuid",
      "patientName": "João Santos",
      "patientPhone": "(11) 98765-4321",
      "assignedTo": "uuid",
      "assignedToName": "Maria Souza",
      "channel": "whatsapp",
      "status": "active",
      "unreadCount": 3,
      "lastMessagePreview": "Olá, quanto custa um hemograma?",
      "lastMessageAt": "2024-08-23T14:30:00Z",
      "tags": ["orçamento", "hemograma"],
      "createdAt": "2024-08-20T10:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  },
  "counts": { "mine": 12, "unassigned": 7 }
}
```

`counts` alimenta os chips "Minhas N" / "Não atribuídas N". Os dois números saem do
MESMO `SELECT` da listagem (`COUNT(*) FILTER (...)`), com os mesmos filtros de
visibilidade, status e busca — nunca de contador mantido à parte (BUSINESS_RULES §5).
Por isso eles **não** mudam quando `?scope=` muda: o chip não clicado continua
mostrando o próprio número, e `pagination.total` é que acompanha o escopo.

Cada item traz `assignedToName` e `lastMessagePreview` já resolvidos (o frontend não
faz request extra por conversa). Shape completo: `Conversation` em
`shared/types/conversation.types.ts`. Anuláveis: `patientName`, `assignedTo`,
`assignedToName`, `lastMessagePreview`, `lastMessageAt`.

**Erros:** `FORBIDDEN` (403, `platform_operator`), `VALIDATION_ERROR` (400, query fora
do enum — `scope`, `status`, `sortBy`, `order`, `limit` > 100)

### GET /conversations/:id
Detalhes de uma conversa + histórico de mensagens.

**Marca a conversa como lida** (**D-035**; PAGES.md §2, "Ao abrir: markAsRead"): zera
`unreadCount` e passa as mensagens do paciente para `status: "read"` — é por isso que
o exemplo abaixo mostra `unreadCount: 0` enquanto a mesma conversa aparece na listagem
com `3`. Quem precisa do efeito sem carregar o histórico usa
`POST /conversations/:id/read`. O `markAsRead` roda **antes** da leitura e aplica o
recorte por papel: conversa fora do escopo do usuário devolve `404` sem ter tocado em
nada.

Mensagens vêm em ordem cronológica **crescente**; `page=1` é a página mais recente.
`messageLimit` default 50, máx. 100.

**Query Params:**
```
?messageLimit=50&page=1
```

`messageLimit` é o nome do contrato; `limit` é aceito como alias tolerante e vale o
mesmo (`messageLimit` ganha quando os dois vêm). Valor acima de 100 é recusado com
`VALIDATION_ERROR` — não é silenciosamente reduzido.

**Response (200):**
```json
{
  "conversation": {
    "id": "uuid",
    "patientName": "João Santos",
    "patientPhone": "(11) 98765-4321",
    "patientEmail": "joao@email.com",
    "assignedTo": "uuid",
    "assignedToName": "Maria Souza",
    "channel": "whatsapp",
    "status": "active",
    "unreadCount": 0,
    "lastMessagePreview": "Oi João! Um hemograma custa R$ 89,90.",
    "lastMessageAt": "2024-08-23T14:27:00Z",
    "customFields": { "document": "123.456.789-00" },
    "tags": ["orçamento"],
    "createdAt": "2024-08-20T10:00:00Z"
  },
  "messages": [
    {
      "id": "uuid",
      "senderType": "patient",
      "senderId": null,
      "senderName": "João Santos",
      "content": "Olá, quanto custa um hemograma?",
      "messageType": "text",
      "attachmentUrl": null,
      "status": "read",
      "readAt": "2024-08-23T14:30:00Z",
      "createdAt": "2024-08-23T14:25:00Z"
    },
    {
      "id": "uuid",
      "senderType": "agent",
      "senderId": "uuid",
      "senderName": "Maria (Atendente)",
      "content": "Oi João! Um hemograma custa R$ 89,90.",
      "messageType": "text",
      "status": "delivered",
      "createdAt": "2024-08-23T14:27:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 120,
    "totalPages": 3
  }
}
```

`conversation` é `ConversationDetail` (= `Conversation` + `patientEmail` +
`customFields`); `messages[]` é `Message`, com `senderName`, `attachmentUrl` e `readAt`
anuláveis. `pagination` é o `PaginationMeta` padrão — os quatro campos, sempre.

**Erros:** `NOT_FOUND` (404 — inexistente, de outro tenant **ou de outro atendente**;
nunca 403), `FORBIDDEN` (403, `platform_operator`), `VALIDATION_ERROR` (400, `:id` não-uuid)

### POST /conversations/:id/messages
Enviar mensagem em uma conversa.

**Request:**
```json
{
  "content": "Ótimo! Vou criar um orçamento para você.",
  "messageType": "text",
  "attachmentUrl": null
}
```

- `content`: 1..4000 caracteres (trim aplicado)
- `messageType` (opcional, default `text`) ∈ `text | image | audio | pdf | doc`
- `attachmentUrl` (opcional, anulável): máx. 500 caracteres

O recorte por papel é aplicado **antes** de escrever: conversa que o usuário não
enxerga devolve `NOT_FOUND`.

**Response (201):**
```json
{
  "id": "uuid",
  "conversationId": "uuid",
  "senderType": "agent",
  "senderId": "uuid",
  "senderName": "Maria Souza",
  "content": "Ótimo! Vou criar um orçamento para você.",
  "messageType": "text",
  "attachmentUrl": null,
  "status": "sent",
  "readAt": null,
  "createdAt": "2024-08-23T14:35:00Z"
}
```

**Erros:** `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `CONVERSATION_ARCHIVED` (409),
`MESSAGE_SEND_FAILED` (502, canal externo falhou após os retries), `FORBIDDEN` (403,
`platform_operator`)

### POST /conversations/:id/read
Marcar a conversa como lida sem carregar o histórico. Idempotente.

**Response:** `204 No Content`

**Erros:** `NOT_FOUND` (404 — inexistente, de outro tenant ou fora do recorte do
usuário), `VALIDATION_ERROR` (400, `:id` não-uuid), `FORBIDDEN` (403, `platform_operator`)

### PATCH /conversations/:id
Atualizar conversa (status, tags, assigned_to).

`assignedTo` cobre assumir, transferir e devolver para a fila (`null`):

- conversa **livre**: a atribuição é decidida pelo banco (`UPDATE ... WHERE assigned_to
  IS NULL`). Duas chamadas simultâneas: a primeira ganha, a segunda recebe
  `CONVERSATION_ALREADY_ASSIGNED` (409) com
  `details: { assignedTo, assignedToName }`
- conversa **já atribuída**: só o próprio dono, gestor ou admin transferem; qualquer
  outro recebe o mesmo 409. A transferência gera a mensagem de sistema "Conversa
  transferida de A para B" (WORKFLOWS §5) e **preserva o histórico**
- `assignedTo` que não seja usuário ativo do laboratório → `VALIDATION_ERROR`

**Request:**
```json
{
  "status": "archived",
  "assignedTo": "uuid",
  "tags": ["orçamento", "realizado"]
}
```

**Response (200):**
```json
{
  "id": "uuid",
  "status": "archived",
  "assignedTo": "uuid",
  "assignedToName": "Maria Souza",
  "tags": ["orçamento", "realizado"]
}
```

Os três campos são opcionais no corpo, mas ao menos um é obrigatório →
`VALIDATION_ERROR`. `tags`: no máximo 20, cada uma de 1 a 50 caracteres. A ordem de
aplicação é **status → tags → atribuição** (deliberada: quem transfere e arquiva na
mesma chamada perderia a visibilidade no meio do caminho se a atribuição viesse antes).
Mudança de status gera audit log `update_conversation_status`; atribuição gera
`assign_conversation`.

**Erros:** `VALIDATION_ERROR` (400), `NOT_FOUND` (404),
`CONVERSATION_ALREADY_ASSIGNED` (409), `FORBIDDEN` (403, `platform_operator`)

---

## 2b. Webhooks do canal (WhatsApp) — PÚBLICOS

Não usam JWT: **quem autentica é a assinatura HMAC**. Verificada ANTES de qualquer
processamento e antes de qualquer escrita (SECURITY.md "Webhooks").

```
POST /webhooks/whatsapp/:tenant          mensagem recebida
POST /webhooks/whatsapp/:tenant/status   callback de status de entrega
POST /webhooks/whatsapp                  idem, com `tenantSlug` no corpo
POST /webhooks/whatsapp/status
```

`:tenant` é o `slug` (ou o uuid) do laboratório — é o que identifica o tenant quando
não há sessão. Resolvido o tenant, toda escrita acontece dentro do contexto de RLS.

**Headers:**
```
x-hub-signature-256: sha256=<hmac-sha256 do corpo, com WHATSAPP_WEBHOOK_SECRET>
```
Aceita também `x-signature-256` e `x-webhook-signature`. A comparação é feita em tempo
constante (`crypto.timingSafeEqual`).

**Request (formato Meta):** `entry[].changes[].value.messages[]` /
`entry[].changes[].value.statuses[]`. O formato simplificado
`{ "from", "text", "externalId" }` também é aceito (é o que o driver mock produz em dev).

**Response (sempre):**
```json
{ "received": true }
```
`200` em TODOS os caminhos — assinatura válida, assinatura inválida, tenant
desconhecido ou payload malformado. A resposta não varia de propósito: variar seria
dar um oráculo de enumeração ao atacante. O que aconteceu fica no log estruturado.

Efeitos do caminho autenticado:
1. `ConversationService.findOrCreateByPhone` — acha a conversa do telefone ou cria uma
   nova, já na fila não atribuída
2. `MessageService.createFromPatient` — grava a mensagem, incrementa `unreadCount`,
   sobe `lastMessageAt`
3. emite `conversation.new_message` no WebSocket, na room do tenant

**Idempotente:** reentrega com o mesmo `id` de mensagem (`external_message_id`) não
duplica linha nem evento.

---

## 3. Proposals (Orçamentos)

### GET /proposals
Listar propostas com filtros.

**Query Params:**
```
?status=novo_contato,orcamento_enviado    // lista separada por vírgula
?page=1&limit=20                          // default page=1, limit=20, máximo 100
?sortBy=createdAt&order=desc              // sortBy: createdAt|updatedAt|totalPrice|status
?conversationId=uuid
?createdBy=uuid
?startDate=2026-08-01&endDate=2026-08-31  // filtra por createdAt
```

`pagination` é o mesmo `PaginationMeta` de toda listagem (D-009):
`{ page, limit, total, totalPages }`.

**Response (200):**
```json
{
  "proposals": [
    {
      "id": "uuid",
      "conversationId": "uuid",
      "patientName": "João Santos",
      "status": "orcamento_enviado",
      "discountPercent": 10,
      "totalPrice": 179.80,
      "createdBy": "uuid",
      "approvalStatus": "none",
      "createdAt": "2024-08-23T14:40:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "total": 45
  }
}
```

### GET /proposals/:id
Detalhes completos de uma proposta.

**Response (200):**
```json
{
  "id": "uuid",
  "conversationId": "uuid",
  "patientName": "João Santos",
  "patientPhone": "(11) 98765-4321",
  "status": "orcamento_enviado",
  "discountPercent": 10,
  "totalPrice": 179.80,
  "items": [
    {
      "id": "uuid",
      "examName": "Hemograma",
      "quantity": 1,
      "unitPrice": 89.90
    },
    {
      "id": "uuid",
      "examName": "Glicose",
      "quantity": 1,
      "unitPrice": 89.90
    }
  ],
  "createdBy": "uuid",
  "createdByName": "Maria (Atendente)",
  "approvalStatus": "none",
  "approvedBy": null,
  "reasonLost": null,
  "history": [
    {
      "status": "novo_contato",
      "changedAt": "2024-08-23T14:40:00Z",
      "changedBy": "uuid"
    },
    {
      "status": "orcamento_enviado",
      "changedAt": "2024-08-23T14:45:00Z",
      "changedBy": "uuid"
    }
  ],
  "createdAt": "2024-08-23T14:40:00Z"
}
```

### POST /proposals
Criar nova proposta.

**Request:**
```json
{
  "conversationId": "uuid",
  "items": [
    { "examId": "uuid", "quantity": 1 },
    { "examId": "uuid", "quantity": 1 }
  ],
  "discountPercent": 10
}
```

**Validações:**
- `discountPercent` não pode exceder alçada do usuário
- Se exceder: vai para `approvalStatus: "pending"`
- Exames devem existir no catálogo
- Quantidade > 0

**Response (201):**
```json
{
  "id": "uuid",
  "conversationId": "uuid",
  "status": "novo_contato",
  "discountPercent": 10,
  "totalPrice": 179.80,
  "items": [...],
  "approvalStatus": "pending",
  "message": "Proposta criada. Aguardando aprovação do gestor."
}
```

**Desconto acima da alçada NÃO é erro nesta rota** (D-045): a proposta é criada com
`approvalStatus: "pending"` e o `message` acima explica a pendência — é o fluxo de
BUSINESS_RULES §2 e WORKFLOWS §3. O código `DISCOUNT_EXCEEDS_LIMIT` (403) aparece em
`PATCH /proposals/:id/discount` quando alguém tenta elevar, acima da própria alçada,
o desconto de uma proposta que **não criou**:

```json
{
  "error": {
    "code": "DISCOUNT_EXCEEDS_LIMIT",
    "message": "Desconto solicitado excede sua alçada",
    "statusCode": 403,
    "details": {
      "requestedDiscount": 40,
      "userLimit": 30,
      "approvalRequired": true
    }
  }
}
```

**Outros erros:** `EXAM_NOT_FOUND_OR_INACTIVE` (400, `details.examIds[]` — exame
inexistente, inativo ou de outro tenant), `NOT_FOUND` (404, conversa inexistente **ou de
outro tenant**), `VALIDATION_ERROR` (400 — o DTO é estrito: `totalPrice`, `unitPrice` ou
qualquer campo de preço vindo do cliente é recusado, nunca ignorado).

**Visibilidade (D-042):** atendente lista e abre apenas as propostas que criou;
gestor/admin veem todas do tenant. Fora da visibilidade: `404`, nunca `403`.

### PATCH /proposals/:id/status
Atualizar status da proposta.

**Request:**
```json
{
  "status": "follow_up"
}
```

**Valores válidos:** `novo_contato`, `orcamento_enviado`, `follow_up`, `negociacao`, `ganho`, `perdido`

**Response (200):**
```json
{
  "id": "uuid",
  "status": "follow_up",
  "updatedAt": "2024-08-23T15:00:00Z"
}
```

### PATCH /proposals/:id/status (para perdido)
Encerrar proposta como perdida.

**Request:**
```json
{
  "status": "perdido",
  "reasonLost": "preço"
}
```

**Valores para `reasonLost`:** `preco`, `silencio`, `exame_indisponivel`, `prazo`, `outro`

**Response (200):**
```json
{
  "id": "uuid",
  "status": "perdido",
  "reasonLost": "preço",
  "updatedAt": "2024-08-23T15:00:00Z"
}
```

### PATCH /proposals/:id/discount
Atualizar desconto (se aprovação pendente).

**Request:**
```json
{
  "discountPercent": 12
}
```

**Response (200):**
```json
{
  "id": "uuid",
  "discountPercent": 12,
  "totalPrice": 175.78
}
```

### PATCH /proposals/:id/approve (admin/manager apenas)
Aprovar proposta que está em `approvalStatus: "pending"`.

**Response (200):**
```json
{
  "id": "uuid",
  "approvalStatus": "approved",
  "approvedAt": "2024-08-23T15:05:00Z",
  "message": "Proposta aprovada com sucesso"
}
```

**Regras (SERVICES.md §6, WORKFLOWS.md §3):**
- Só `manager`/`admin`, **e só dentro da própria alçada**: um gestor de 30% não aprova 40%
- Ninguém aprova a própria proposta, nem admin (D-046)
- O criador é notificado por `approval.decided` no WebSocket; a decisão é auditada

**Erros:** `FORBIDDEN` (403, `details.requiredRoles: ["manager","admin"]` — ou
`details.reason: "self_approval"`), `APPROVAL_NOT_ALLOWED` (403,
`details: { discount, approverLimit }`), `CONFLICT` (409, `details.approvalStatus` — a
proposta não está `pending`), `PROPOSAL_ALREADY_CLOSED` (409), `NOT_FOUND` (404 —
inexistente **ou de outro tenant**)

### PATCH /proposals/:id/reject (admin/manager apenas)
Rejeitar o desconto pendente. Simétrico a `/approve`.

**Request:**
```json
{
  "reason": "Margem insuficiente neste convênio"
}
```

**Response (200):**
```json
{
  "id": "uuid",
  "approvalStatus": "rejected",
  "approvedAt": null,
  "message": "Proposta rejeitada"
}
```

- `reason` é obrigatório (1..500 caracteres) → `VALIDATION_ERROR`
- `approvedBy`/`approvedAt` continuam `null`: null significa "não foi aprovada"
  (BUSINESS_RULES §10). Quem rejeitou fica no audit log
- O motivo volta em `GET /proposals/:id` no campo `rejectionReason` (D-041)
- Proposta rejeitada **não** pode ir para `orcamento_enviado` (D-047): o caminho é ajustar
  o desconto em `PATCH /discount`, que reavalia a alçada

**Erros:** os mesmos de `/approve`, mais `VALIDATION_ERROR` (400)

---

## 3b. Internal Chat (Chat Interno)

Canais internos do laboratório (SERVICES.md §7, WORKFLOWS.md §6). Canais padrão:
`#geral` e `#aprovacoes` — o sistema posta os pedidos de aprovação no segundo, com a
proposta anexada. O console de plataforma **não** acessa estes canais (PAGES.md §11):
`platform_operator` recebe `FORBIDDEN`.

### GET /internal-chat/channels

**Response (200):**
```json
{
  "channels": [
    {
      "id": "uuid",
      "key": "aprovacoes",
      "name": "#aprovacoes",
      "kind": "channel",
      "unreadCount": 0,
      "lastMessageAt": "2026-08-23T14:40:00.000Z"
    }
  ]
}
```

`unreadCount` é sempre `0` enquanto não houver estado de leitura por usuário no schema
(D-044). `lastMessageAt` é anulável (canal sem mensagem). Ordem fixa: `kind ASC`,
depois `key ASC` — `channel` antes de `dm`, sem parâmetro de ordenação. Sem paginação:
a resposta é `{ channels }`, só isso.

**Erros:** `FORBIDDEN` (403, `platform_operator`)

### GET /internal-chat/channels/:id/messages

**Query Params:**
```
?page=1&limit=50           // default page=1, limit=50, máximo 100
```

**Response (200):** ordem cronológica (mais antiga primeiro).
```json
{
  "messages": [
    {
      "id": "uuid",
      "channelId": "uuid",
      "senderId": null,
      "senderName": "Sistema",
      "content": "@gestor Pedido de aprovação de desconto: João Santos - R$ 150,00 (25% — acima da alçada de 15%)",
      "attachedProposalId": "uuid",
      "isSystem": true,
      "createdAt": "2026-08-23T14:40:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 1, "totalPages": 1 }
}
```

Ordenação fixa `created_at ASC, id ASC` — não há `sortBy` nem `order` aqui.

**Erros:** `NOT_FOUND` (404 — canal inexistente **ou de outro tenant**),
`VALIDATION_ERROR` (400 — `:id` não-uuid, `limit` > 100), `FORBIDDEN` (403,
`platform_operator`)

### POST /internal-chat/channels/:id/messages

**Request:**
```json
{
  "content": "Olhem este orçamento",
  "attachedProposalId": "uuid"
}
```

- `content`: 1..4000 caracteres
- `attachedProposalId` (opcional) precisa existir **no mesmo tenant** → senão `NOT_FOUND`;
  o frontend renderiza a proposta anexada como cartão clicável

**Response (201):** o `InternalMessage` criado **sem envelope** (mesmo shape dos itens
acima). Emite `internal_chat.new_message` no WebSocket (room = tenantId).
Mensagem de usuário nasce com `isSystem: false` e `senderId`/`senderName` do autor;
`isSystem: true` é exclusivo do que o próprio sistema posta (pedido de aprovação).

**Erros:** `VALIDATION_ERROR` (400 — `content` vazio ou > 4000, `attachedProposalId`
não-uuid, campo desconhecido), `NOT_FOUND` (404 — canal ou proposta anexada de outro
tenant), `FORBIDDEN` (403, `platform_operator`)

---

## 4. Exam Catalog

### GET /exams
Listar catálogo de exames do laboratório.

**Query Params:**
```
?active=true                 // omitido = ativos e inativos
?category=hemograma          // sem sensibilidade a caixa nem a acento
?search=glicose              // casa NOME e CÓDIGO, sem caixa nem acento
?page=1&limit=50             // default page=1, limit=20, limite máximo 100
?sortBy=name&order=asc       // sortBy: name|code|category|pricePrivate|priceInsurance|createdAt|updatedAt
```

**Response (200):**
```json
{
  "exams": [
    {
      "id": "uuid",
      "name": "Hemograma",
      "code": "HC",
      "description": "Análise completa do sangue",
      "preparation": "Jejum de 8 horas",
      "turnaroundHours": 24,
      "pricePrivate": 89.90,
      "priceInsurance": 75.00,
      "category": "hemograma",
      "isActive": true,
      "createdAt": "2026-08-23T14:30:00.000Z",
      "updatedAt": "2026-08-23T14:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

`pagination` é o mesmo `PaginationMeta` de toda listagem (D-009). Não existe
`DELETE /exams/:id`: desativar é `PATCH /exams/:id { "isActive": false }`, porque propostas
históricas referenciam o exame (D-004).

### POST /exams (manager/admin apenas)
Criar novo exame no catálogo.

**Request:**
```json
{
  "name": "Novo Exame",
  "code": "NE",
  "description": "...",
  "preparation": "...",
  "turnaroundHours": 24,
  "pricePrivate": 100.00,
  "priceInsurance": 80.00,
  "category": "hemograma"
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "name": "Novo Exame",
  "code": "NE",
  ...
}
```

### PATCH /exams/:id (manager/admin apenas)
Atualizar exame.

**Request:**
```json
{
  "pricePrivate": 110.00,
  "priceInsurance": 90.00,
  "isActive": false
}
```

**Response (200):**
```json
{
  "id": "uuid",
  "pricePrivate": 110.00,
  "priceInsurance": 90.00,
  "isActive": false
}
```

---

## 5. Analytics & Reports

**Dinheiro é NÚMERO nestes endpoints** (`15000`, `2666.67`), nunca string formatada.
A versão anterior deste documento mostrava `"R$ 15.000,00"` nos exemplos; isso contraria
`FRONTEND_BACKEND.md` ("Datas e Dinheiro") e os tipos de `@crm-lab/shared`, que já são
`number`. Corrigido — ver **D-018** em `docs/DECISIONS.md`. A formatação pt-BR é do
frontend (`MoneyDisplay`).

**As duas janelas de tempo** (D-020) — um relatório de período responde a duas perguntas
diferentes, e elas não usam a mesma data:

| Métrica | Janela |
|---------|--------|
| `funnel.*`, `conversionRate`, `lossReasons` | propostas **criadas** no período (`createdAt`) |
| `revenue`, `averageTicket`, `topPerformers` | propostas **ganhas** no período (`closedAt`) |

Uma proposta criada em julho e ganha em agosto entra na receita de agosto e no funil de
julho. Todos os números derivam da tabela `proposals` (BUSINESS_RULES.md §5).

**Escopo por perfil:** atendente recebe apenas as próprias métricas, com `partial: true`;
gestor e admin recebem as do time (`partial: false`). O escopo sai do papel no token — nunca
de parâmetro da query. `platform_operator` recebe `403 FORBIDDEN`.

**Cache:** 5 min por `(tenantId, escopo do usuário, relatório, período)`.

### GET /analytics/conversion
Dashboard de conversão (funil).

**Query Params:**
```
?startDate=2026-08-01&endDate=2026-08-31   # ISO YYYY-MM-DD, endDate INCLUSIVO, UTC
?groupBy=daily|weekly|monthly              # aceito; série temporal ainda não exposta
```
Sem datas: últimos 30 dias terminando hoje (UTC). Formato inválido, data inexistente ou
`startDate > endDate` → `400 VALIDATION_ERROR` com `details.fields`.

**Response (200):**
```json
{
  "period": { "startDate": "2026-08-01", "endDate": "2026-08-31" },
  "funnel": {
    "novoContato": 500,
    "orcamentoEnviado": 350,
    "followUp": 200,
    "negociacao": 100,
    "ganho": 50,
    "perdido": 50,
    "conversionRate": 10.0
  },
  "lossReasons": {
    "preco": 20,
    "silencio": 15,
    "exame_indisponivel": 10,
    "prazo": 5,
    "outro": 0
  },
  "revenue": 90000,
  "averageTicket": 1800,
  "topPerformers": [
    { "userId": "uuid", "name": "Maria Silva", "conversions": 15, "revenue": 15000 }
  ],
  "partial": false
}
```
`lossReasons` traz **sempre as 5 chaves** de `LOSS_REASONS`, com `0` onde não houve perda —
o gráfico do frontend não pode ficar com buracos. `conversionRate` = ganhos / total criadas
no período, em pontos percentuais. `averageTicket` = `revenue / count(ganhas)`, e é `0` (não
`NaN`) quando não houve ganho.

### GET /analytics/pipeline
Estado atual do pipeline (sem janela de tempo).

**Response (200):**
```json
{
  "byStatus": {
    "novo_contato":      { "count": 50, "value": 90000 },
    "orcamento_enviado": { "count": 35, "value": 63000 },
    "follow_up":         { "count": 20, "value": 36000 },
    "negociacao":        { "count": 10, "value": 18000 },
    "ganho":             { "count": 40, "value": 72000 },
    "perdido":           { "count": 12, "value": 21600 }
  },
  "totalValue": 207000,
  "averageTicket": 1800,
  "openCount": 115,
  "oldestProposal": { "id": "uuid", "daysOpen": 15, "status": "follow_up" }
}
```
`byStatus` traz sempre os **6** estágios, zerados inclusive. `totalValue`, `averageTicket` e
`openCount` cobrem o que está **em aberto** (os 4 estágios não terminais) — é isso que
"pipeline" significa; ganho e perdido continuam visíveis em `byStatus`. `oldestProposal` é
`null` quando não há nenhuma proposta aberta.

### GET /analytics/team
Desempenho por atendente — **gestor/admin apenas** (atendente → `403 FORBIDDEN` com
`details.requiredRoles: ["manager","admin"]`).

**Query Params:** iguais aos de `/analytics/conversion`.

**Response (200):**
```json
{
  "period": { "startDate": "2026-08-01", "endDate": "2026-08-31" },
  "members": [
    {
      "userId": "uuid",
      "name": "Maria Silva",
      "created": 6,
      "won": 2,
      "lost": 1,
      "conversionRate": 33.33,
      "revenue": 7000,
      "averageTicket": 3500
    }
  ],
  "totals": {
    "created": 10, "won": 3, "lost": 2,
    "conversionRate": 30, "revenue": 9000, "averageTicket": 3000
  }
}
```
Usuário sem movimento no período aparece zerado, não some da tabela.

---

## 5b. Platform Console (`platform_operator` apenas)

Console isolado (PAGES.md §11). Estas são as **únicas** rotas que cruzam tenants, e a
contrapartida vale nos dois sentidos:

- todas exigem `requireRoles('platform_operator')` → qualquer outro papel recebe `403 FORBIDDEN`
  com `details.requiredRoles: ["platform_operator"]`;
- o operador **não tem caminho** para `/conversations`, `/proposals`, `/internal-chat`,
  `/themes`, `/users`, `/audit`, `/exams` nem `/analytics` — todas respondem `403` para
  ele. Isolamento é requisito, não configuração.

O `403` chega por dois caminhos, com `details.requiredRoles` diferente:
`denyPlatformOperator()` responde `{ requiredRoles: ["attendant", "manager", "admin"] }`;
nas rotas que já exigem papel elevado (`PATCH /proposals/:id/approve` e `/reject`,
`POST /exams`, `PATCH /exams/:id`) quem barra é o próprio `requireRoles`, e o
`details.requiredRoles` é `["manager", "admin"]`. O frontend faz switch no `code`, não
no `details` — mas quem escreve teste precisa saber qual dos dois vai ver.

Nenhuma resposta desta seção carrega dado clínico ou de conversa: sem nome/telefone/e-mail de
paciente, sem conteúdo de mensagem, sem canal interno e sem valor de proposta. Contagem
agregada (`userCount`, `proposalCount`, `messagesUsed`) é o limite — número sem sujeito.

### GET /platform/tenants

**Query Params:** `?page=1&limit=20&search=vida&isActive=true&plan=starter|pro|enterprise`

`limit` máx. 100 (default 20). `search` casa **nome ou slug** (`ILIKE %termo%`, máx. 255).
`isActive` só aceita `"true"`/`"false"`. Ordenação fixa `created_at DESC, name ASC`.
O shape da query é `ListTenantsQuery` (`shared/types/platform.types.ts`) — **fonte única**:
backend e frontend importam de lá, nenhum dos dois redeclara os filtros localmente.
`subscriptionUntil` é `IsoDate` (`YYYY-MM-DD`, sem hora) e é anulável.

**Response (200):**
```json
{
  "tenants": [
    {
      "id": "uuid",
      "name": "Laboratório Vida",
      "slug": "lab-vida",
      "isActive": true,
      "subscriptionPlan": "pro",
      "subscriptionUntil": "2026-12-31",
      "userCount": 8,
      "createdAt": "2026-01-10T12:00:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 3, "totalPages": 1 }
}
```

### POST /platform/tenants
Onboarding (WORKFLOWS.md §7). Cria, em **uma única transação**: tenant + tema padrão
(Terracota & Sálvia) + canais `#geral` e `#aprovacoes` + usuário admin inicial. Se qualquer
passo falhar, nada é gravado e o `slug` continua livre.

**Request:**
```json
{
  "name": "Laboratório Vida",
  "slug": "lab-vida",
  "plan": "pro",
  "adminEmail": "admin@labvida.com.br",
  "adminName": "Admin Vida",
  "adminPassword": "senha-super-segura"
}
```
`slug` é canonizado (minúsculo, `a-z0-9-`) antes de decidir duplicidade; depois de
canonizado precisa ter ao menos 2 caracteres. `name` e `adminName`: 2..255.
`adminEmail`: e-mail válido, máx. 255. `adminPassword`: 8..200 caracteres. Campo
desconhecido no corpo é recusado (schema `strict`). O admin inicial nasce com a alçada
padrão do papel `admin` (`DEFAULT_DISCOUNT_LIMIT.admin`).

O tema criado é o `DEFAULT_THEME` (preset `terracota`, `fontId: "figtree"`,
`radiusId: "suave"`) com `brandName` já preenchido com o **nome do laboratório** —
não `null`, ao contrário de um tenant que nunca passou pelo onboarding.

**Response (201):** `{ "tenant": TenantSummary }` — o mesmo shape de `GET /platform/tenants`,
tipado como `CreateTenantResponse` em `shared/types/platform.types.ts`.
`slug` já existente → `409 CONFLICT` com `details: { field: "slug", slug }`. DTO
inválido → `400 VALIDATION_ERROR` com `details.fields`.

### GET /platform/billing
Assinaturas & Uso. Mensalidade = plano + excedente de mensagens do **mês corrente** (UTC).

**Response (200):**
```json
{
  "usage": [
    {
      "tenantId": "uuid",
      "tenantName": "Laboratório Vida",
      "plan": "pro",
      "messagesIncluded": 5000,
      "messagesUsed": 5250,
      "extraMessages": 250,
      "proposalCount": 44,
      "monthlyPrice": 824
    }
  ],
  "totals": { "mrr": 824, "tenants": 1, "messages": 5250 }
}
```
`extraMessages` é **derivado** (`max(0, messagesUsed - messagesIncluded)`), não lido de
`tenants.extra_messages` — contador materializado seria uma segunda origem para o mesmo
número (BUSINESS_RULES.md §5).

Planos e excedente, como estão no código (`PLAN_CATALOG`, `EXTRA_MESSAGE_PRICE` —
**D-019**):

| plano | `monthlyPrice` base | `messagesIncluded` |
|---|---|---|
| `starter` | 299 | 1000 |
| `pro` | 799 | 5000 |
| `enterprise` | 1999 | 20000 |

Excedente: **R$ 0,10** por mensagem. `monthlyPrice` da resposta é
`base + extraMessages × 0.10` (no exemplo: `799 + 250 × 0,10 = 824`). Dinheiro é número
decimal, nunca string formatada.

Recorte dos agregados — **não é o mesmo para os três**:
- `usage[]` lista **todos** os laboratórios, ativos ou não;
- `totals.mrr` soma o `monthlyPrice` **só dos ativos** (lab suspenso não fatura) e
  `totals.tenants` conta **só os ativos**;
- `totals.messages` soma `messagesUsed` de **todos** os laboratórios da lista,
  inclusive inativos — é volume de tráfego, não faturamento.

---

## Error Responses

Todos os erros seguem este formato:

**Response (40x/50x):**
```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Mensagem amigável",
    "statusCode": 400,
    "details": {
      "field": "error details"
    }
  }
}
```

### Códigos de Erro Comuns

| Código | HTTP | Descrição |
|--------|------|-----------|
| `UNAUTHORIZED` | 401 | Token ausente ou inválido |
| `FORBIDDEN` | 403 | Permissão insuficiente |
| `NOT_FOUND` | 404 | Recurso não encontrado |
| `VALIDATION_ERROR` | 400 | Validação falhou |
| `DISCOUNT_EXCEEDS_LIMIT` | 403 | Desconto acima da alçada |
| `TENANT_NOT_FOUND` | 404 | Tenant não encontrado |
| `DATABASE_ERROR` | 500 | Erro no banco de dados |

---

## Rate Limiting

```
Limite: 100 requisições por minuto por usuário
Headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
```

**Response (429):**
```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Limite de requisições excedido",
    "retryAfter": 30
  }
}
```

---

## WebSocket Events (Real-time)

Conexão: `ws://localhost:3000/ws?token=JWT`

**Eventos Subscribe:**
```javascript
socket.on('conversation.new_message', (data) => {...})
socket.on('proposal.status_changed', (data) => {...})
socket.on('approval.requested', (data) => {...})
socket.on('user.came_online', (data) => {...})
```

**Eventos Emit:**
```javascript
socket.emit('message.read', { messageId, conversationId })
socket.emit('proposal.update_discount', { proposalId, discount })
```

---

## Próximas Leituras

- `docs/api/API_ERRORS.md` - Códigos de erro detalhados
- `docs/api/AUTHENTICATION.md` - Detalhes de autenticação
- `docs/contracts/FRONTEND_BACKEND.md` - Contrato frontend ↔ backend

