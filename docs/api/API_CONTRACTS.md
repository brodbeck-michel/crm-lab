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

## Envelope de resposta (regra do projeto — D-070)

Vale para **todo** endpoint, existente ou novo. Três casos, sem quarta opção:

| Caso | Forma | Exemplos |
|------|-------|----------|
| **Listagem** | chave nomeada no plural + `pagination` (D-009) | `{ users, pagination }`, `{ proposals, pagination }`, `{ patients, pagination }` |
| **Recurso único** (GET, POST, PATCH) | o objeto **cru**, sem envelope | `POST /users`, `PATCH /users/:id`, `GET /users/me`, `POST /exams`, `GET /proposals/:id`, `POST /internal-chat/.../messages`, `GET /patients/:id` |
| **Resposta composta** (mais de um recurso, ou recurso + meta) | chaves nomeadas, uma por parte | `{ conversation, messages, pagination }`, `{ channels, distributionMode, ... }`, `{ patient, conversationsAffected }` |

Sem corpo (`204`): `POST /conversations/:id/read`, `POST /internal-chat/channels/:id/read`.

**Como decidir:** se a resposta descreve **uma** entidade e nada mais, ela é a entidade. Se
carrega uma segunda coisa (lista + paginação, entidade + contador, duas entidades), cada parte
ganha nome. Envelopar um recurso único só adiciona um nível que o cliente tem que desembrulhar
sem ganhar nada em troca — e a maioria esmagadora dos endpoints já era crua.

### Ajustes exigidos por esta regra (dono: **Agent-API-Fixes**)

| Endpoint | Era | Passa a ser |
|----------|-----|-------------|
| `POST /platform/tenants` (201) | `{ "tenant": TenantSummary }` | `TenantSummary` cru |

`CreateTenantResponse` em `shared/types/platform.types.ts` já é `TenantSummary` (alias) —
backend e frontend seguem o tipo. É a única mudança: os demais endpoints de recurso único já
respondiam crus.

### Exceção explícita, registrada

| Endpoint | Forma | Por quê |
|----------|-------|---------|
| `GET /themes/current` e `PATCH /themes/current` | `{ "theme": Theme }` | O mesmo objeto viaja aninhado em `tenant.theme` no `POST /auth/login`; desembrulhar aqui criaria duas formas do mesmo dado no bootstrap, e o ganho seria zero |
| `PATCH /proposals/:id/status` | `{ id, status, reasonLost, updatedAt }` | **Projeção parcial**, não envelope: devolve só os campos que a transição mudou. O recurso inteiro sai em `GET /proposals/:id`; recarregar a proposta toda a cada arrastar de card no Kanban seria desperdício |
| `PATCH /proposals/:id/discount` | `{ id, discountPercent, totalPrice }` | Mesma razão: só o que o recálculo mudou (§1) |
| `PATCH /proposals/:id/approve` e `PATCH /proposals/:id/reject` | `{ id, approvalStatus, approvedAt }` | Mesma razão. **Não carregam mais `message`** (Onda 6): texto de interface em pt-BR vindo do backend não tem quem o traduza — i18n é do frontend, e `approvalStatus` já carrega toda a informação |
| `POST /webhooks/whatsapp` (e variantes por tenant) | `{ "received": true }` | **Não é recurso:** é o ACK que a Meta exige. Não expõe nada do domínio e é idêntico em todos os caminhos, inclusive nos ignorados (§4) |

`POST /proposals` devolve `ProposalDetail` **cru**, sem campo extra (`CreateProposalResponse`,
`shared/types/proposal.types.ts`, é hoje só um alias de `ProposalDetail`). Até a Onda 7 havia um
`message` opcional em pt-BR quando a proposta caía em aprovação; foi removido (C7) pela mesma
razão de `PATCH .../approve` e `.../reject` (Onda 6, linha acima): texto de interface é do
frontend (i18n), e `approvalStatus: "pending"` já carrega toda a informação que a tela precisa.

Fora dessas linhas, qualquer envelope de recurso único é bug de contrato, não estilo.

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
`update_proposal_discount`, `approve_discount`, `reject_discount`, `update_patient`,
`export_patient_data`, `anonymize_patient`, `update_channel_settings` e `create_tenant`
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
      "patientId": "3f1c9b0e-2d54-4a7b-9c11-8e2a6d5f4b30",
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
      "pinned": true,
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

`pinned` é **do usuário que pediu** (Onda 8 §2.3): a mesma conversa vem `true` para quem
a fixou e `false` para as colegas. Conversas fixadas vêm **primeiro**, e dentro de cada
grupo a ordenação pedida (`sortBy`/`order`) continua valendo. Os `counts` **não** mudam:
fixar é organização visual, não filtro.

`counts` alimenta os chips "Minhas N" / "Não atribuídas N". Os dois números saem do
MESMO `SELECT` da listagem (`COUNT(*) FILTER (...)`), com os mesmos filtros de
visibilidade, status e busca — nunca de contador mantido à parte (BUSINESS_RULES §5).
Por isso eles **não** mudam quando `?scope=` muda: o chip não clicado continua
mostrando o próprio número, e `pagination.total` é que acompanha o escopo.

Cada item traz `assignedToName` e `lastMessagePreview` já resolvidos (o frontend não
faz request extra por conversa). Shape completo: `Conversation` em
`shared/types/conversation.types.ts`. Anuláveis: `patientId`, `patientName`, `assignedTo`,
`assignedToName`, `lastMessagePreview`, `lastMessageAt`.

`patientId` é o **id do cadastro** (`patients.id`, D-059) — a porta de entrada da Ficha do
Paciente (`/patients/:id`, PAGES.md §3). Campo **opcional acrescentado em D-079**: backward
compatible, cliente que não conhece o campo ignora. É `null` para conversa anterior ao backfill
da migração 003 que ainda não passou por `findOrCreateByPhone` (D-072) — e nesse caso a UI
**não mostra o link**, em vez de mostrar um link quebrado. Os campos denormalizados
`patientName`/`patientPhone` continuam sendo o que a lista renderiza (D-059): `patientId` serve
para navegar, não para exibir.

**Erros:** `FORBIDDEN` (403, `platform_operator`), `VALIDATION_ERROR` (400, query fora
do enum — `scope`, `status`, `sortBy`, `order`, `limit` > 100)

### POST /conversations
Criar um atendimento que **não veio do WhatsApp** — ligação, balcão, formulário do site.
É a porta de entrada manual do pipeline (PAGES.md §5): cria a conversa e a tela segue para
`/budget/new?conversationId=`, onde a proposta é montada pelo caminho de sempre.

**Request:**
```json
{
  "patientPhone": "(48) 99999-1234",
  "patientName": "Maria Souza",
  "patientEmail": null,
  "channel": "direct"
}
```

- `patientPhone`: obrigatório, 10 a 13 dígitos depois de descartar máscara. É normalizado para
  o mesmo formato que o webhook grava (`+5548999991234`) **antes** de procurar duplicata — sem
  isso o mesmo paciente ganharia uma segunda conversa por ter sido digitado sem o código do país
- `patientName`: obrigatório, 1..255
- `patientEmail`: opcional/anulável, e-mail válido, máx. 255
- `channel` ∈ `direct | web | sms`. **`whatsapp` é recusado** com `VALIDATION_ERROR`: conversa
  desse canal nasce apenas pelo webhook, que deduplica por `externalId`. "Ligação" e "presencial"
  caem as duas em `direct` — separá-las exigiria coluna nova (fora do escopo do v1)

**Comportamento:** mesmo `findOrCreateByPhone` do webhook — a linha de `patients` é criada ou
reaproveitada na MESMA transação (D-059). Duas diferenças: o canal vem do formulário e a conversa
nasce **atribuída a quem cadastrou** (`assigned_to = usuário logado`), não na fila livre. Conversa
**preexistente** naquele telefone é devolvida como está, **sem trocar de dono** — criar não
reatribui; para isso existe `PATCH /conversations/:id`.

**Response (201):** `ConversationDetail` cru — o mesmo shape do campo `conversation` de
`GET /conversations/:id`. `201` também quando a conversa foi reaproveitada: o cliente não
distingue os dois casos, e não precisa — o destino é o mesmo.

**Erros:** `VALIDATION_ERROR` (400 — telefone/nome/e-mail inválidos, `channel` fora do enum),
`CONVERSATION_ALREADY_ASSIGNED` (409, `details: { assignedTo, assignedToName }`) quando o telefone
já tem conversa **de outro atendente**. Aqui o 409 é deliberado, e é a exceção à regra do 404:
devolver `NOT_FOUND` mandaria o atendente montar orçamento numa conversa que ele não consegue
abrir. `FORBIDDEN` (403, `platform_operator`).

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
    "patientId": "3f1c9b0e-2d54-4a7b-9c11-8e2a6d5f4b30",
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
`customFields`) — inclui `patientId`, que é de onde a coluna 3 do inbox tira o link para a
ficha (D-079); `messages[]` é `Message`, com `senderName`, `attachmentUrl` e `readAt`
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

### POST /conversations/:id/attachments
Enviar um anexo (Onda 8 §4.3) — foto, PDF ou áudio para o paciente.

**Base64 em JSON, não multipart:** Express 4 não faz multipart sozinho, e o
gateway Evolution já resolve mídia em base64 nos dois sentidos. O custo é
~33% mais bytes no fio — irrelevante para recado de voz e foto de pedido
médico.

**Request:**
```json
{
  "fileName": "pedido-medico.jpg",
  "mimeType": "image/jpeg",
  "contentBase64": "/9j/4AAQSkZJRg..."
}
```

- `fileName`: 1..255 caracteres (usado só para exibição — o arquivo em disco é
  nomeado pelo id da mídia, nunca por este valor)
- `mimeType`: 1..127 caracteres
- `contentBase64`: obrigatório, decodificado e checado contra o teto de
  tamanho (15 MiB por arquivo)

O recorte por papel é aplicado **antes** de gravar: conversa que o usuário não
enxerga devolve `NOT_FOUND`. `messageType` é derivado do `mimeType`
(`image/* → image`, `audio/* → audio`, `application/pdf → pdf`, resto →
`doc`) — o cliente não escolhe.

**Response (201):** o mesmo shape de `POST /conversations/:id/messages`, com
`attachmentUrl` apontando para `GET /media/:id` (nunca uma URL pública):

```json
{
  "id": "uuid",
  "conversationId": "uuid",
  "senderType": "agent",
  "senderId": "uuid",
  "senderName": "Maria Souza",
  "content": "pedido-medico.jpg",
  "messageType": "image",
  "attachmentUrl": "/api/v1/media/uuid",
  "status": "sent",
  "readAt": null,
  "createdAt": "2026-09-06T14:35:00Z"
}
```

**Erros:** `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `CONVERSATION_ARCHIVED` (409),
`MEDIA_TOO_LARGE` (413, acima do teto de 15 MiB), `MESSAGE_SEND_FAILED` (502, canal
externo falhou após os retries — a WhatsApp Cloud API `cloud_api` ainda não envia
mídia, só o gateway Evolution `qr`), `FORBIDDEN` (403, `platform_operator`)

### POST /conversations/:id/read
Marcar a conversa como lida sem carregar o histórico. Idempotente.

**Response:** `204 No Content`

**Erros:** `NOT_FOUND` (404 — inexistente, de outro tenant ou fora do recorte do
usuário), `VALIDATION_ERROR` (400, `:id` não-uuid), `FORBIDDEN` (403, `platform_operator`)

### GET /conversations/assignees
Quem pode receber uma conversa neste laboratório — a lista do menu "Transferir"
(PAGES.md §2). Aberta a **qualquer papel de tenant**, porque quem mais transfere é a
atendente, e `GET /users` é admin-only.

Devolve **só** `id`, `name` e `role` de usuários **ativos** com papel de tenant
(`attendant`, `manager`, `admin`). Nada de e-mail, alçada ou estado de conta:
afrouxar o `GET /users` existente vazaria a lista de pessoal completa para todo
atendente — mudança de superfície de segurança que ninguém pediu.

**Response (200):**
```json
{
  "assignees": [
    { "id": "uuid", "name": "Ana Lima", "role": "attendant" },
    { "id": "uuid", "name": "Maria Souza", "role": "manager" }
  ]
}
```

Ordenado por nome. `platform_operator` nunca aparece na lista **e** recebe `FORBIDDEN`
na rota (PAGES.md §11).

A transferência em si continua sendo `PATCH /conversations/:id` com
`{ "assignedTo": "<uuid>" | null }` — `null` devolve para a fila. Não há endpoint novo
para transferir.

**Erros:** `FORBIDDEN` (403, `platform_operator`), `UNAUTHORIZED` (401)

### POST /conversations/:id/pin · DELETE /conversations/:id/pin
Fixar / desafixar a conversa no topo da **sua** lista (Onda 8 §2.3). Qualquer papel de
tenant. O pin é **pessoal**: não altera nada que as colegas vejam.

**Response:** `204 No Content` nos dois verbos.

**Idempotentes:** fixar o que já está fixado é `204`, não erro; desafixar o que não está
fixado também. A chave `(user_id, conversation_id)` faz o trabalho no banco
(`ON CONFLICT DO NOTHING`).

Conversa inexistente, de outro tenant ou fora do recorte do usuário → `NOT_FOUND` (nunca
`FORBIDDEN`, CLAUDE.md regra 8). Fixar **não** gera audit log: é preferência de tela, não
ato sobre o atendimento.

**Erros:** `NOT_FOUND` (404), `VALIDATION_ERROR` (400, `:id` não-uuid), `FORBIDDEN` (403,
`platform_operator`)

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

### Webhook do gateway Evolution (WhatsApp QR, Onda 7 — Bloco B) — PÚBLICO

```
POST /webhooks/evolution/:tenant
```

`:tenant` é o `slug` (ou uuid) do laboratório, mesmo padrão de `/webhooks/whatsapp/:tenant`
acima (D-032). Autentica por **token estático** em vez de HMAC — o gateway Evolution não assina
o corpo; a defesa é a comparação em tempo constante
(`crypto.timingSafeEqual`) do header contra `EVOLUTION_WEBHOOK_TOKEN`:

```
x-evolution-webhook-token: <EVOLUTION_WEBHOOK_TOKEN>
```

Mesma disciplina do webhook Meta: **kill switch `is_active` verificado antes de tudo** (D-074,
antes até do token), e resposta invariável para não dar oráculo de enumeração.

**Request (formato Evolution), três eventos traduzidos para os DTOs internos existentes.**

> ⚠️ **Grafia do `event`:** o gateway v2.3.7 envia **`messages.upsert`** — minúsculo e separado
> por **ponto** (verificado no `WebhookController` do container). A grafia `MESSAGES_UPSERT`
> deste documento era uma suposição: com comparação exata, nenhum evento real casava e a
> mensagem recebida sumia em silêncio. A rota normaliza (`toUpperCase()` + `.` → `_`) e aceita
> **as duas**; os exemplos abaixo usam a forma real.

```json
{ "event": "messages.upsert", "instance": "tenant-8f2a1c4b", "data": { "key": { "remoteJid": "554899990000@s.whatsapp.net", "id": "3EB0C767D26A1D2F4B", "fromMe": false }, "message": { "conversation": "Bom dia, gostaria de orçamento" }, "messageTimestamp": 1756555200 } }
```
Endereçamento por **LID** (privacidade do WhatsApp): `remoteJid` vem como `<id>@lid` e o
telefone real viaja em `remoteJidAlt`.
```json
{ "event": "messages.upsert", "instance": "tenant-8f2a1c4b", "data": { "key": { "remoteJid": "128999376343081@lid", "remoteJidAlt": "554899990000@s.whatsapp.net", "addressingMode": "lid", "fromMe": false }, "message": { "conversation": "Oi" } } }
```
```json
{ "event": "connection.update", "instance": "tenant-8f2a1c4b", "data": { "state": "open" } }
```
```json
{ "event": "qrcode.updated", "instance": "tenant-8f2a1c4b", "data": { "qrcode": { "base64": "data:image/png;base64,..." } } }
```

**Response (sempre):**
```json
{ "received": true }
```
`200` em TODOS os caminhos — token válido, token inválido, tenant desconhecido, canal
desativado ou payload malformado. Try/catch **por mensagem** dentro de `MESSAGES_UPSERT` (a
Evolution também pode entregar lote): uma mensagem malformada no meio do lote não derruba as
demais.

Efeitos:
**Qual `key` vira atendimento** (`inboundPhoneOf`, um único ponto de decisão — `remoteJid` nem
sempre é telefone, e tratá-lo como se fosse cria paciente fantasma que ninguém consegue
responder):

| `key` | Efeito |
|---|---|
| `fromMe: true` | **ignorada** — é o próprio número do laboratório respondendo pelo celular |
| `remoteJid` termina em `@g.us` | **ignorada** — id de grupo não é paciente |
| `remoteJid` termina em `@lid` | telefone lido de **`remoteJidAlt`** |
| `@lid` sem `remoteJidAlt` | **descartada** — LID não é discável, não casa com o cadastro e não serve para responder; conversa presa a um LID seria pior que nenhuma |
| `<telefone>@s.whatsapp.net` | telefone lido do próprio `remoteJid` |

- `MESSAGES_UPSERT` → **reusa o caminho inteiro** do webhook Meta:
  `findOrCreateByPhone` → `MessageService.createFromPatient` (dedupe por `externalId`,
  `unreadCount`, `lastMessageAt`, WS `conversation.new_message`). A tela de Atendimento não
  muda — é o mesmo dado entrando por um canal diferente.
  **Mídia (Onda 8 §4.2):** `message.imageMessage`/`audioMessage`/`documentMessage` são
  reconhecidos ao lado de `conversation`/`extendedTextMessage` (o webhook é registrado com
  `base64: true`). Arquivo acima do teto (15 MiB) é recusado com log — a mensagem não é
  criada, mas o evento continua respondendo `200 {received:true}` do mesmo jeito. **Risco
  aceito:** o campo exato onde o gateway v2.3.7 grava o base64 não foi confirmado contra um
  payload real; o parser aceita tanto `message.<tipo>Message.base64` quanto o nível do
  `message` — verificar contra o gateway de verdade antes de depender disto em produção.
- `CONNECTION_UPDATE` com `state: "open"` → grava `connected_at`, `phone_number` (informado
  pelo gateway), `connection_mode: "qr"`, `is_active: true` em `tenant_channels`.
- `CONNECTION_UPDATE` com `state: "close"` (inclusive `loggedOut`, que é como o gateway informa
  desconexão/banimento) → marca desconectado; a UI mostra "Reconectar". O contrato não distingue
  desconexão voluntária de banimento — ver a nota de risco em `docs/architecture/SECURITY.md`.
- `QRCODE_UPDATED` → atualiza o QR vigente lido por `GET /settings/channels/whatsapp/qr`.

**Idempotente:** mesma disciplina do webhook Meta — reentrega da mesma mensagem
(`externalId`/`key.id`) não duplica linha nem evento.

---

## 2c. Patients (Ficha do Paciente)

Tela `/patients/:id` (PAGES.md §3) e a entidade `patients` (D-059, SCHEMA.md §14). Shapes em
`shared/types/patient.types.ts`.

**Papéis:** `attendant`, `manager` e `admin` acessam a seção; `platform_operator` recebe `403
FORBIDDEN` em **todas** as rotas (`denyPlatformOperator()`, PAGES.md §11 — o console não tem
caminho para dado de paciente). `GET /patients/:id/export` e `POST /patients/:id/anonymize`
exigem `admin`.

**Visibilidade por papel (D-060), igual à de conversas:** o atendente enxerga apenas os
pacientes que têm **ao menos uma conversa visível para ele** — atribuída a ele ou na fila não
atribuída. Gestor e admin veem todos os do laboratório. Paciente fora da visibilidade responde
`404 NOT_FOUND`, nunca `403` (CLAUDE.md regra 8) — e o mesmo recorte se aplica **dentro** da
ficha: contadores e timeline só contam o que o solicitante já podia ver por outro caminho.

**Não existe `POST /patients`.** O paciente nasce do canal: `findOrCreateByPhone` resolve ou
cria a linha pelo telefone dentro do tenant (`UNIQUE (tenant_id, phone)`) quando a conversa
chega. Não há fluxo de UI para cadastrar paciente sem conversa, e um `POST` criaria uma segunda
origem para a mesma entidade. `phone` também não é editável por `PATCH` — é a chave de
deduplicação.

**Não existe `DELETE /patients/:id`.** O caminho LGPD de apagamento é
`POST /patients/:id/anonymize` (D-063).

### GET /patients
Busca da ficha (a tela chega aqui pela busca do inbox ou por link direto).

**Consumidor real:** a busca da coluna 1 do Atendimento (PAGES.md §2) — com 2+ caracteres ela
consulta este endpoint com `limit=5` e mostra o bloco "Pacientes" abaixo da fila de conversas
(D-079). Cada resultado leva a `/patients/:id`.

**Query Params:**
```
?page=1&limit=20                      (limit máx. 100 — PaginationMeta de D-009)
?search=joão                          (máx. 120 caracteres)
?sortBy=name|lastInteractionAt|createdAt|updatedAt&order=asc|desc
```

`search` casa **três** coisas, em OR: nome (full-text `portuguese`, mesma expressão do índice
GIN de SCHEMA.md §14), telefone (o termo é reduzido a dígitos e só entra quando sobram **3
dígitos ou mais**, igual a `/conversations`) e documento (dígitos, casamento por prefixo).
`sortBy` default `lastInteractionAt`, `order` default `desc`; qualquer valor fora do enum →
`VALIDATION_ERROR`.

**Response (200):**
```json
{
  "patients": [
    {
      "id": "3f1c9b0e-2d54-4a7b-9c11-8e2a6d5f4b30",
      "phone": "(11) 98765-4321",
      "name": "João Santos",
      "email": "joao@email.com",
      "birthDate": "1984-03-12",
      "document": "12345678900",
      "notes": "Prefere coleta pela manhã.",
      "tags": ["convênio", "recorrente"],
      "customFields": { "convenio": "Unimed" },
      "anonymizedAt": null,
      "lastInteractionAt": "2026-08-23T14:30:00.000Z",
      "createdAt": "2026-06-02T10:00:00.000Z",
      "updatedAt": "2026-08-20T09:15:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 137, "totalPages": 7 }
}
```

`lastInteractionAt` é derivado (`MAX(conversations.last_message_at)` das conversas **visíveis**),
nunca coluna materializada — BUSINESS_RULES §5. É `null` para paciente sem interação visível.

**Erros:** `VALIDATION_ERROR` (400), `FORBIDDEN` (403, `platform_operator`)

### GET /patients/:id
Cadastro + contadores. **Não** embute timeline nem propostas (D-060): a timeline é paginada e
cresce sem limite, e as propostas já têm listagem própria com visibilidade e paginação
prontas. Embutir as três coisas faria a abertura da ficha carregar centenas de linhas para
mostrar as 10 primeiras, e os três blocos da tela têm ciclos de atualização diferentes.

A tela faz três chamadas, cada uma com sua chave de cache:

| Bloco da tela | Chamada |
|---|---|
| Cadastro + contadores | `GET /patients/:id` |
| Histórico de interações | `GET /patients/:id/timeline` |
| Propostas do paciente | `GET /proposals?patientId=<id>` |

**Response (200):** o `PatientDetail` **cru** (regra de envelope).
```json
{
  "id": "3f1c9b0e-2d54-4a7b-9c11-8e2a6d5f4b30",
  "phone": "(11) 98765-4321",
  "name": "João Santos",
  "email": "joao@email.com",
  "birthDate": "1984-03-12",
  "document": "12345678900",
  "notes": "Prefere coleta pela manhã.",
  "tags": ["convênio", "recorrente"],
  "customFields": { "convenio": "Unimed" },
  "anonymizedAt": null,
  "conversationCount": 4,
  "proposalCount": 2,
  "lastInteractionAt": "2026-08-23T14:30:00.000Z",
  "createdAt": "2026-06-02T10:00:00.000Z",
  "updatedAt": "2026-08-20T09:15:00.000Z"
}
```

`conversationCount` e `proposalCount` contam **o que o solicitante enxerga**: para o atendente,
suas conversas mais as não atribuídas, e as propostas que ele criou (D-042). Dois usuários
podem ver números diferentes na mesma ficha — é o comportamento correto, e a tela não deve
prometer "total do laboratório".

**Erros:** `NOT_FOUND` (404 — inexistente, de outro tenant **ou fora da visibilidade**),
`VALIDATION_ERROR` (400, `:id` não-uuid), `FORBIDDEN` (403, `platform_operator`)

### PATCH /patients/:id
Edita o cadastro. Qualquer papel de laboratório que enxergue o paciente pode editar (a ficha é
a tela de trabalho do atendente).

**Request:** (todos opcionais, ao menos um → senão `VALIDATION_ERROR`)
```json
{
  "name": "João Santos",
  "email": "joao@email.com",
  "birthDate": "1984-03-12",
  "document": "123.456.789-00",
  "notes": "Prefere coleta pela manhã.",
  "tags": ["convênio", "recorrente"],
  "customFields": { "convenio": "Unimed" }
}
```

- **`null` apaga, campo ausente preserva** — a mesma semântica de `PATCH /themes/current`.
- `phone` **não** é aceito: enviar → `VALIDATION_ERROR` (o schema é `strict`; campo desconhecido
  também é recusado).
- `name` 1..255 · `email` e-mail válido, máx. 255 · `notes` máx. 4000.
- `birthDate`: `YYYY-MM-DD`, data existente, **não futura** → senão `VALIDATION_ERROR`.
- `document`: aceita formatado ou só dígitos; é **normalizado para 11 dígitos** antes de gravar.
  Dígito verificador de CPF é validado → `VALIDATION_ERROR` com `details.fields.document`.
- `tags`: no máximo 20, cada uma de 1 a 50 caracteres (mesmo limite de `/conversations`).
- `customFields`: no máximo 30 chaves, chave de 1 a 50 e valor de 0 a 500 caracteres, tudo
  string (valor não-string → `VALIDATION_ERROR`).
- **As colunas denormalizadas de `conversations` NÃO são atualizadas por este PATCH** (D-059):
  elas são o histórico do que o canal informou; a ficha é o cadastro. Enquanto as duas
  existirem, `/conversations` continua respondendo o valor denormalizado.
- Gera audit log `update_patient` com `oldValues`/`newValues` apenas dos campos que mudaram.
- Paciente anonimizado → `409 CONFLICT` com `details.reason: "patient_anonymized"`.

**Response (200):** o `PatientDetail` atualizado, **cru** (mesmo shape do `GET`).

**Erros:** `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `CONFLICT` (409, anonimizado),
`FORBIDDEN` (403, `platform_operator`)

### GET /patients/:id/timeline
Histórico de interações: mensagens, propostas e mudanças de estágio em **uma** linha do tempo.

**Query Params:**
```
?page=1&limit=50          (default 50, máx. 100)
?kind=message|conversation_started|proposal_created|proposal_stage_changed
?order=desc|asc           (default: desc — mais recente primeiro)
```

**Response (200):**
```json
{
  "entries": [
    {
      "id": "proposal_stage_changed:8c2e1f77-0b13-4a3d-9d54-1f0e6b7a2c19",
      "kind": "proposal_stage_changed",
      "at": "2026-08-23T15:00:00.000Z",
      "proposalId": "6d9a4c2b-71e5-4f18-8b0a-3c5d2e9f1a44",
      "from": "orcamento_enviado",
      "to": "follow_up",
      "changedByName": "Maria Souza"
    },
    {
      "id": "proposal_created:6d9a4c2b-71e5-4f18-8b0a-3c5d2e9f1a44",
      "kind": "proposal_created",
      "at": "2026-08-23T14:40:00.000Z",
      "proposalId": "6d9a4c2b-71e5-4f18-8b0a-3c5d2e9f1a44",
      "status": "orcamento_enviado",
      "discountPercent": 10,
      "totalPrice": 179.80,
      "createdByName": "Maria Souza"
    },
    {
      "id": "message:b1d4e7a9-5c62-4e30-9f81-2a7c8b3d6e05",
      "kind": "message",
      "at": "2026-08-23T14:25:00.000Z",
      "conversationId": "a7f3c2d1-4e58-49b6-8c02-7d1e5f9a3b64",
      "senderType": "patient",
      "senderName": "João Santos",
      "messageType": "text",
      "preview": "Olá, quanto custa um hemograma?"
    },
    {
      "id": "conversation_started:a7f3c2d1-4e58-49b6-8c02-7d1e5f9a3b64",
      "kind": "conversation_started",
      "at": "2026-08-20T10:00:00.000Z",
      "conversationId": "a7f3c2d1-4e58-49b6-8c02-7d1e5f9a3b64",
      "channel": "whatsapp"
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 128, "totalPages": 3 }
}
```

- `entries[]` é a união discriminada `PatientTimelineEntry` — o frontend faz switch em `kind`.
- `id` é `"<kind>:<uuid da origem>"`: as quatro origens são tabelas diferentes, e um uuid
  sozinho colidiria entre `proposal_created` e `proposal_stage_changed` da mesma proposta.
  Serve de `key` de lista; não é identificador de recurso e não é aceito em nenhuma rota.
- Ordenação: `at DESC, id DESC` (o desempate por `id` mantém a página estável quando duas
  origens têm o mesmo instante). `order=asc` inverte os dois.
- `preview` é o `content` da mensagem **truncado em 160 caracteres** pelo backend, sem
  reticências adicionadas — a tela decide como indicar o corte. Anexo sem texto vira string
  vazia; `messageType` diz o que era.
- **Mesmo recorte de visibilidade da ficha:** entram só mensagens/aberturas de conversas
  visíveis ao solicitante e propostas visíveis por D-042. Sem isso a timeline seria um caminho
  lateral para o atendente ler a conversa de outro atendente.
- `total` conta as entradas do recorte, não as do laboratório.

**Erros:** `NOT_FOUND` (404), `VALIDATION_ERROR` (400), `FORBIDDEN` (403, `platform_operator`)

### GET /patients/:id/export — LGPD (admin apenas)
Exportação dos dados do titular (SECURITY.md "LGPD"; PAGES.md §3 "seção LGPD — checada também
no servidor").

**Papel:** `admin`. Gestor e atendente recebem `403 FORBIDDEN` com
`details.requiredRoles: ["admin"]`. Motivo (D-062): atender pedido de titular é ato de
controlador de dados, e o export junta num arquivo só tudo que o laboratório tem sobre a
pessoa — inclusive conversas que o solicitante não veria pela UI. Por isso o export **não**
aplica o recorte por papel da ficha: ele é o dado completo do titular no tenant, e a defesa é a
restrição de papel + auditoria, não um filtro parcial que produziria uma exportação incompleta
(e portanto errada, do ponto de vista da LGPD).

**Formato:** JSON (`Content-Type: application/json; charset=utf-8`) com
`Content-Disposition: attachment; filename="paciente-<id>-<YYYYMMDD>.json"`. JSON e não CSV
porque o dado é aninhado (conversas → mensagens, propostas → itens); um CSV exigiria achatar e
perderia estrutura. Sem paginação: é um dump.

**Response (200):** `PatientExport`.
```json
{
  "generatedAt": "2026-08-24T12:00:00.000Z",
  "patient": { "id": "3f1c9b0e-...", "phone": "(11) 98765-4321", "name": "João Santos", "...": "..." },
  "conversations": [
    {
      "id": "a7f3c2d1-4e58-49b6-8c02-7d1e5f9a3b64",
      "channel": "whatsapp",
      "status": "active",
      "createdAt": "2026-08-20T10:00:00.000Z",
      "messages": [
        {
          "id": "b1d4e7a9-5c62-4e30-9f81-2a7c8b3d6e05",
          "senderType": "patient",
          "senderName": "João Santos",
          "content": "Olá, quanto custa um hemograma?",
          "messageType": "text",
          "createdAt": "2026-08-23T14:25:00.000Z"
        }
      ]
    }
  ],
  "proposals": [
    {
      "id": "6d9a4c2b-71e5-4f18-8b0a-3c5d2e9f1a44",
      "status": "orcamento_enviado",
      "discountPercent": 10,
      "totalPrice": 179.80,
      "items": [ { "examName": "Hemograma", "quantity": 1, "unitPrice": 89.90 } ],
      "createdAt": "2026-08-23T14:40:00.000Z"
    }
  ]
}
```

**Entra:** o cadastro inteiro — inclusive `notes`, `tags` e `customFields`. São anotações
internas (BUSINESS_RULES §7), mas são dado pessoal do titular, e a LGPD não isenta anotação por
ela ser interna. Mensagens de sistema (`senderType: "system"`) também entram: fazem parte do
histórico da conversa dele.

`discountPercent` e `totalPrice` entram porque são o orçamento que o titular recebeu.

**Não entra** — é dado do laboratório, não do titular: `approvalStatus`, alçada do atendente,
quem aprovou ou rejeitou e o motivo, chat interno da equipe, audit log.

Gera audit log `export_patient_data` (`entityType: "patient"`, `entityId: :id`) — SECURITY.md
exige registro da exportação.

**Erros:** `FORBIDDEN` (403, `details.requiredRoles: ["admin"]`), `NOT_FOUND` (404),
`VALIDATION_ERROR` (400, `:id` não-uuid)

### POST /patients/:id/anonymize — LGPD (admin apenas)
Apagamento a pedido do titular (D-063). **Não** deleta linha: anonimiza.

**Request:**
```json
{ "reason": "Pedido de exclusão do titular via e-mail em 2026-08-24" }
```
`reason` obrigatório, 1..500 caracteres → senão `VALIDATION_ERROR`. Vai para o audit log.

**Efeito, em uma única transação:**

1. `patients`: `name`, `email`, `birth_date`, `document`, `notes` → `NULL`; `tags` → `[]`;
   `custom_fields` → `{}`; `phone` → `'anon-' || substring(id::text, 1, 8)`;
   `anonymized_at` → `NOW()`.
2. `conversations` com `patient_id = :id`: `patient_name` e `patient_email` → `NULL`,
   `patient_phone` → o mesmo placeholder. São **cópias** denormalizadas da identidade do
   paciente (SCHEMA.md §3); deixá-las intactas tornaria a anonimização decorativa — o nome
   continuaria na lista do inbox.
3. `proposals`, `proposal_items`, `messages`, `internal_messages` e `audit_logs` ficam
   **intactos**. A proposta histórica continua válida e somando no funil: `patientName` já é
   anulável em `Proposal`, então ela passa a aparecer sem nome. Reescrever valor de proposta ou
   apagar audit log para "sumir" com o paciente quebraria a integridade contábil e a regra de
   log append-only.
4. Audit log `anonymize_patient` com `newValues: { reason }` — **nunca** com os valores antigos
   (gravar o nome apagado no log seria desfazer a anonimização em outra tabela).

**Limitação conhecida, documentada:** o **conteúdo** das mensagens não é reescrito. O texto é
registro da conversa e pode conter o nome; expurgo de mensagem é a política de retenção
mencionada em SECURITY.md "LGPD" ("config futura"), não este endpoint.

**Response (200):**
```json
{
  "patient": {
    "id": "3f1c9b0e-2d54-4a7b-9c11-8e2a6d5f4b30",
    "phone": "anon-3f1c9b0e",
    "name": null,
    "email": null,
    "birthDate": null,
    "document": null,
    "notes": null,
    "tags": [],
    "customFields": {},
    "anonymizedAt": "2026-08-24T12:05:00.000Z",
    "createdAt": "2026-06-02T10:00:00.000Z",
    "updatedAt": "2026-08-24T12:05:00.000Z"
  },
  "conversationsAffected": 4
}
```

**Idempotente:** paciente já anonimizado devolve `200` com o mesmo estado e
`conversationsAffected: 0` — não `409`. Repetir o pedido do titular não é conflito, e um erro
aqui empurraria o operador a procurar outro caminho.

Depois de anonimizado, `PATCH /patients/:id` responde `409 CONFLICT`
(`details.reason: "patient_anonymized"`); `GET` e `export` continuam funcionando e mostram o
cadastro vazio — é a prova de que o apagamento aconteceu.

**Erros:** `VALIDATION_ERROR` (400), `FORBIDDEN` (403, `details.requiredRoles: ["admin"]`),
`NOT_FOUND` (404)

---

## 2d. Media (Onda 8 §4)

### GET /media/:id
Baixa o arquivo de mídia de uma mensagem (foto, PDF ou áudio).

**NUNCA servido como arquivo estático público** (`express.static`): é exame e
áudio de paciente. Rota autenticada, filtrada por tenant (RLS) — mídia de
outro tenant é `NOT_FOUND` (CLAUDE.md regra 8), nunca `FORBIDDEN`.

**Response (200):** o corpo bruto do arquivo, com `Content-Type` do
`mimeType` gravado e `Content-Disposition: inline; filename="..."`.

**Erros:** `NOT_FOUND` (404 — inexistente ou de outro tenant), `VALIDATION_ERROR`
(400, `:id` não-uuid), `FORBIDDEN` (403, `platform_operator`)

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
?patientId=uuid                           // propostas do paciente (D-060)
?createdBy=uuid
?startDate=2026-08-01&endDate=2026-08-31  // filtra por createdAt
?search=maria                             // nome do paciente, máx. 100 caracteres
```

**`?search=`** casa trecho do nome do paciente (`conversations.patient_name`, `ILIKE %termo%`,
case-insensitive) — é a busca do Pipeline (PAGES.md §5). Diferente de `/conversations`, aqui
**não** há busca por telefone nem full-text: o campo do Kanban filtra cartão por nome. O termo
é aparado; vazio equivale a não enviar. O recorte por papel de D-042 continua por cima —
atendente que busca por nome segue vendo só as propostas que criou.

`pagination` é o mesmo `PaginationMeta` de toda listagem (D-009):
`{ page, limit, total, totalPages }`. `limit` é grampeado em 100 e **`page` em 10.000**
(`MAX_PAGE`) — igual em `/patients`: sem teto, `?page=9007199254740991` custaria um `COUNT(*)`
inteiro e um scan com OFFSET absurdo. Valor acima é grampeado, não recusado.

**`?patientId=` (D-060)** é como a ficha do paciente (§2c) lista as propostas dele — não há
`GET /patients/:id/proposals`. O filtro resolve por `conversations.patient_id` (a proposta não
tem coluna de paciente; ela nasce de uma conversa), e herda de graça o que já existe aqui:
visibilidade por papel de D-042 (atendente só vê as que criou), paginação, ordenação e o mesmo
shape de item. Um endpoint próprio duplicaria as quatro coisas e faria o `PatientService` ler a
tabela `proposals`, que é de outro domínio (SERVICES.md "Convenções Transversais").
Paciente inexistente ou fora da visibilidade devolve **lista vazia**, não `404` — o filtro não
é oráculo de existência, exatamente como `?createdBy=` de outro usuário (D-042).

**Response (200):**
```json
{
  "proposals": [
    {
      "id": "uuid",
      "proposalNumber": 123,
      "conversationId": "uuid",
      "patientName": "João Santos",
      "status": "orcamento_enviado",
      "discountPercent": 10,
      "totalPrice": 179.80,
      "insuranceId": "8f2a1c4b-6d39-4f70-9a12-5c8e3b7d1f06",
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

`insuranceId` (Onda 7) é `null` numa proposta particular — mesmo campo de `GET /proposals/:id`
abaixo.

`proposalNumber` é sequencial **POR TENANT** (não global), gerado no servidor em `POST
/proposals` — o cliente nunca envia. Serve para rastreamento citável por telefone/WhatsApp
(o UUID de `id` não é citável); a UI formata como `#000123` (`formatProposalNumber` em
`@crm-lab/shared`).

### GET /proposals/:id
Detalhes completos de uma proposta.

**Response (200):**
```json
{
  "id": "uuid",
  "proposalNumber": 123,
  "conversationId": "uuid",
  "patientName": "João Santos",
  "patientPhone": "(11) 98765-4321",
  "status": "orcamento_enviado",
  "discountPercent": 10,
  "totalPrice": 179.80,
  "insuranceId": "8f2a1c4b-6d39-4f70-9a12-5c8e3b7d1f06",
  "items": [
    {
      "id": "uuid",
      "examName": "Hemograma",
      "quantity": 1,
      "unitPrice": 72.50,
      "priceSource": "insurance"
    },
    {
      "id": "uuid",
      "examName": "Vitamina D 25-OH",
      "quantity": 1,
      "unitPrice": 120.00,
      "priceSource": "private"
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

`insuranceId` (Onda 7) é `null` numa proposta particular. `items[].priceSource` é o snapshot de
onde `unitPrice` veio no momento da criação: `"insurance"` quando havia preço cadastrado em
`exam_prices` para o convênio da proposta, `"private"` quando caiu no fallback (segundo item do
exemplo — a proposta tem convênio, mas o exame não tinha preço cadastrado para ele). A UI marca
o item com badge "particular" quando `priceSource === "private"` numa proposta **com** convênio.

### POST /proposals
Criar nova proposta.

**Request:**
```json
{
  "conversationId": "uuid",
  "insuranceId": "8f2a1c4b-6d39-4f70-9a12-5c8e3b7d1f06",
  "items": [
    { "examId": "uuid", "quantity": 1 },
    { "examId": "uuid", "quantity": 1 }
  ],
  "discountPercent": 10
}
```

`insuranceId` (Onda 7) é opcional: `null`/ausente = particular (D-082). Quando presente, o
preço de cada item é resolvido por convênio (`ExamCatalogService.resolveActiveByIds(...,
insuranceId)`, SERVICES.md §5) com fallback automático para `pricePrivate` quando o exame não
tem preço cadastrado para aquele convênio — o fallback **nunca bloqueia** a criação da proposta
(decisão 4 do spec da Onda 7).

**Validações:**
- `discountPercent` não pode exceder alçada do usuário
- Se exceder: vai para `approvalStatus: "pending"`
- Exames devem existir no catálogo
- Quantidade > 0
- `insuranceId`, se enviado, deve existir e estar ativo no tenant — convênio inexistente/de
  outro tenant/inativo → `VALIDATION_ERROR`

**Response (201):**
```json
{
  "id": "uuid",
  "proposalNumber": 124,
  "conversationId": "uuid",
  "status": "novo_contato",
  "discountPercent": 10,
  "totalPrice": 173.25,
  "insuranceId": "8f2a1c4b-6d39-4f70-9a12-5c8e3b7d1f06",
  "items": [
    {
      "id": "uuid",
      "examName": "Hemograma",
      "quantity": 1,
      "unitPrice": 72.50,
      "priceSource": "insurance"
    },
    {
      "id": "uuid",
      "examName": "Vitamina D 25-OH",
      "quantity": 1,
      "unitPrice": 120.00,
      "priceSource": "private"
    }
  ],
  "approvalStatus": "pending"
}
```

**`PATCH /proposals/:id` não permite trocar `insuranceId` após a criação, nesta onda** — não há
campo `insuranceId` em nenhum `PATCH` de proposta (nem no schema Zod que os valida). Trocar de
convênio re-precificaria itens com snapshot já gravado (D-004) — comportamento novo que
exigiria decisão própria, registrado aqui como **limitação declarada** da Onda 7 (spec §3.3).

**Desconto acima da alçada NÃO é erro nesta rota** (D-045): a proposta é criada com
`approvalStatus: "pending"`, que já diz que ela está aguardando aprovação do gestor — é o fluxo
de BUSINESS_RULES §2 e WORKFLOWS §3 (texto de interface fica por conta do frontend, C7 da
Onda 7). O código `DISCOUNT_EXCEEDS_LIMIT` (403) aparece em
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
  "approvedAt": "2024-08-23T15:05:00Z"
}
```
Projeção parcial de `ProposalDetail` — exceção registrada na tabela de D-070. **Sem
`message`:** texto de interface é do frontend (i18n); `approvalStatus` já diz o que houve.

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
  "approvedAt": null
}
```
Mesma projeção parcial de `/approve`, e igualmente sem texto de UI.

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

Além dos canais fixos, um laboratório tem **mensagens diretas (DM)** — conversa 1:1 entre
dois usuários do mesmo tenant (D-101). `GET /internal-chat/users` lista com quem dá para
conversar; `POST /internal-chat/dms` abre (ou cria, na primeira vez) a DM.

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
      "unreadCount": 2,
      "lastReadAt": "2026-08-23T14:10:00.000Z",
      "lastMessageAt": "2026-08-23T14:40:00.000Z",
      "otherUserId": null,
      "otherUserName": null
    },
    {
      "id": "uuid",
      "key": "dm:1111...:2222...",
      "name": "dm:1111...:2222...",
      "kind": "dm",
      "unreadCount": 0,
      "lastReadAt": null,
      "lastMessageAt": null,
      "otherUserId": "uuid",
      "otherUserName": "João Santos"
    }
  ]
}
```

`otherUserId`/`otherUserName` só existem quando `kind: "dm"` — é o OUTRO participante,
resolvido a partir de quem está perguntando (dois usuários da mesma DM veem nomes
diferentes um do outro, nunca o próprio). `name` de uma linha `dm` é um valor interno
(a própria `key`) e **não deve ser exibido** — a tela usa sempre `otherUserName` para DM
(D-101). Uma DM só aparece para os dois participantes: um terceiro usuário do mesmo
tenant não a vê nesta lista.

**`unreadCount` agora é de verdade (D-068 — supera D-044).** É derivado a cada leitura da
tabela `channel_reads` (SCHEMA.md §17), nunca materializado: conta as mensagens do canal com
`created_at > lastReadAt` que **não** foram escritas pelo próprio usuário. Mensagem de sistema
(`senderId: null`) conta — o pedido de aprovação em `#aprovacoes` é justamente o que precisa
piscar. Usuário que nunca abriu o canal tem `lastReadAt: null` e vê todas as mensagens de
terceiros contadas.

`lastReadAt` é a última leitura **deste** usuário neste canal (anulável). A tela usa para
desenhar o divisor "novas mensagens"; dois usuários recebem números diferentes na mesma
resposta, e isso é o esperado.

`lastMessageAt` é anulável (canal sem mensagem). Ordem fixa: `kind ASC`, depois `key ASC` —
`channel` antes de `dm`, sem parâmetro de ordenação. Sem paginação: a resposta é
`{ channels }`, só isso.

**Erros:** `FORBIDDEN` (403, `platform_operator`)

### POST /internal-chat/channels/:id/read
Marcar o canal como lido pelo usuário logado. É o que zera `unreadCount` (D-068) — fecha a
pendência D5 da Onda 5, em que o badge subia e nunca descia.

Sem corpo. Faz `INSERT ... ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = NOW()`
em `channel_reads` — **idempotente**, e chamar em canal já lido não é erro.

**Response:** `204 No Content`

A tela chama ao abrir o canal (mesma ergonomia de `POST /conversations/:id/read`). Diferente de
conversas, `GET /internal-chat/channels/:id/messages` **não** marca como lido: ler página
antiga do histórico não significa ter visto a mensagem nova, e o `GET` com efeito colateral de
`/conversations` (D-035) existe porque lá a página 1 É o fim da conversa. Não gera audit log:
leitura de canal não é ação crítica (SECURITY.md "Auditoria").

**Erros:** `NOT_FOUND` (404 — canal inexistente **ou de outro tenant**),
`VALIDATION_ERROR` (400, `:id` não-uuid), `FORBIDDEN` (403, `platform_operator`)

### GET /internal-chat/channels/:id/messages

**Query Params:**
```
?page=1&limit=50           // default page=1, limit=50, máximo 100
```

**Paginação (D-069): `page=1` é a página das mensagens MAIS RECENTES**, e os itens dentro dela
vêm em ordem cronológica **crescente** (a mais antiga da página primeiro). `page=2` traz o
bloco imediatamente anterior, e assim por diante — subir no histórico é aumentar `page`.

É a mesma convenção já documentada em `GET /conversations/:id` ("`page=1` é a página mais
recente"), e existe pelo mesmo motivo: um chat abre no fim. A implementação anterior fatiava
do começo (`created_at ASC` + `OFFSET` a partir da mensagem número 1), então abrir um canal
no estado útil custava **dois** requests — um para descobrir `totalPages`, outro para buscar a
última página. Quem implementa segue o que está escrito aqui: o `OFFSET` é contado a partir do
fim (`total - page * limit`, com o resto virando a última página do histórico).

A última página (a mais antiga) pode vir com menos itens que `limit`; a página 1 vem cheia
sempre que houver mensagens suficientes. `totalPages = ceil(total / limit)`, como em toda
listagem.

**Response (200):** itens em ordem cronológica crescente dentro da página.
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

Ordenação fixa `created_at ASC, id ASC` **dentro da página** — não há `sortBy` nem `order`
aqui. O que a paginação escolhe é qual fatia do histórico a página cobre (a mais recente
primeiro, D-069), não a ordem dos itens.

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

### GET /internal-chat/users

Diretório de usuários do laboratório com quem dá para abrir uma DM (D-101). **Não** é
`GET /users` (admin-only, tela de gestão) — esta rota é acessível a qualquer membro do
laboratório (attendant/manager/admin), porque é dado de "com quem posso conversar", não
de administração.

**Response (200):**
```json
{
  "users": [
    { "id": "uuid", "name": "João Santos", "role": "attendant" }
  ]
}
```

Exclui o próprio usuário que pergunta e usuários inativos (`is_active = false`). Ordenado
por `name ASC`. Sem paginação, sem busca — o laboratório é pequeno o bastante para uma
lista só.

**Erros:** `FORBIDDEN` (403, `platform_operator`)

### POST /internal-chat/dms

Abre a DM com outro usuário do tenant — **cria na primeira vez, reaproveita nas
seguintes** (get-or-create idempotente, D-101, mesmo padrão de
`POST /settings/channels/whatsapp/connect`).

**Request:**
```json
{ "userId": "uuid" }
```

**Response (200):** o `Channel` (mesmo shape de `GET /internal-chat/channels`, sem
envelope), com `kind: "dm"` e `otherUserId`/`otherUserName` já preenchidos.

**Erros:**
- `VALIDATION_ERROR` (400 — `userId` não-uuid, ou igual ao próprio usuário do contexto:
  não é possível abrir DM consigo mesmo)
- `NOT_FOUND` (404 — `userId` inexistente, inativo, **ou de outro tenant**)
- `FORBIDDEN` (403, `platform_operator`)

---

## 4. Exam Catalog

Shapes em `shared/types/exam.types.ts`. Onda 7 acrescenta TUSS/AMB, material, sinônimos e
`source` ao catálogo, e o preço por convênio (`shared/types/insurance.types.ts`, SCHEMA.md
§19) — ver D-081/D-082/D-083 em `docs/DECISIONS.md`.

### GET /exams
Listar catálogo de exames do laboratório.

**Query Params:**
```
?active=true                 // omitido = ativos e inativos
?category=hemograma          // sem sensibilidade a caixa nem a acento
?search=glicose              // casa NOME, CÓDIGO e SINÔNIMO, sem caixa nem acento (Onda 7)
?page=1&limit=50             // default page=1, limit=20, limite máximo 100
?sortBy=name&order=asc       // sortBy: name|code|category|pricePrivate|priceInsurance|createdAt|updatedAt
?insuranceId=uuid            // Onda 7: acrescenta effectivePrice/priceSource a cada item
```

**Response (200), sem `?insuranceId=`:**
```json
{
  "exams": [
    {
      "id": "uuid",
      "name": "Hemograma completo",
      "code": "HC",
      "description": "Análise completa do sangue",
      "preparation": "Jejum de 8 horas",
      "turnaroundHours": 24,
      "pricePrivate": 89.90,
      "priceInsurance": 75.00,
      "category": "hemograma",
      "isActive": true,
      "tussCode": "40304361",
      "ambCode": null,
      "material": "Sangue — tubo tampa roxa (EDTA)",
      "source": "manual",
      "synonyms": ["sangue completo", "exame de sangue", "hemograma com plaquetas", "HMG", "CBC"],
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

**Response (200), com `?insuranceId=<uuid>`** — cada item ganha `effectivePrice` e
`priceSource` (aditivo, backward compatible; sem o parâmetro os dois campos não aparecem):
```json
{
  "exams": [
    {
      "id": "uuid",
      "name": "Hemograma completo",
      "code": "HC",
      "pricePrivate": 89.90,
      "priceInsurance": 75.00,
      "tussCode": "40304361",
      "ambCode": null,
      "material": "Sangue — tubo tampa roxa (EDTA)",
      "source": "manual",
      "synonyms": ["sangue completo", "exame de sangue"],
      "isActive": true,
      "createdAt": "2026-08-23T14:30:00.000Z",
      "updatedAt": "2026-08-23T14:30:00.000Z",
      "effectivePrice": 72.50,
      "priceSource": "insurance"
    },
    {
      "id": "uuid",
      "name": "Vitamina D 25-OH",
      "code": "VITD",
      "pricePrivate": 120.00,
      "priceInsurance": 95.00,
      "tussCode": "40302830",
      "ambCode": null,
      "material": "Sangue — tubo tampa amarela (gel separador)",
      "source": "manual",
      "synonyms": [],
      "isActive": true,
      "createdAt": "2026-08-23T14:30:00.000Z",
      "updatedAt": "2026-08-23T14:30:00.000Z",
      "effectivePrice": 120.00,
      "priceSource": "private"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 150, "totalPages": 8 }
}
```

O segundo item não tem linha em `exam_prices` para o convênio pedido — cai no `pricePrivate`
(fallback nunca bloqueia, decisão 4 do spec) e `priceSource: "private"` marca a origem para a
UI exibir o badge "particular".

`pagination` é o mesmo `PaginationMeta` de toda listagem (D-009). Não existe
`DELETE /exams/:id`: desativar é `PATCH /exams/:id { "isActive": false }`, porque propostas
históricas referenciam o exame (D-004).

A chave de cache da listagem (`exams:<tenantId>:list:<filtros>`) incorpora `insuranceId`;
mutação de `exam_prices` (via `upsertPrices`) invalida o mesmo prefixo `exams:<tenantId>:` que
mutação de `exam_catalog` já invalida. Mutação de `insurances` **não** invalida esse prefixo:
`effectivePrice` deriva só de `exam_prices` e de `exam_catalog.price_private` — o estado
(`isActive`) do convênio não entra no cálculo da listagem, só no caminho de escrita de
`upsertPrices` (que recusa `insuranceId` inativo). Fazer `InsuranceService` invalidar o
catálogo seria invalidação sem efeito.

**Dois consumidores, dois usos das MESMAS chaves — o contrato não muda para nenhum** (D-080):
`/catalog` é tabela e TROCA de página (`?page=2` na URL); o seletor de `/budget/new` ACUMULA
páginas (`page=1,2,3…&active=true`) e usa `?search=` como recorte principal. `search` casa nome e
código no banco, sobre o catálogo inteiro — nunca sobre as linhas já carregadas pelo cliente. É a
combinação que torna todo exame ativo alcançável na tela de orçamento; antes dela a tela pedia uma
página só e o resto do catálogo era invisível.

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
  "category": "hemograma",
  "tussCode": "40304361",
  "ambCode": null,
  "material": "Sangue — tubo tampa roxa (EDTA)",
  "synonyms": ["sinônimo 1", "sinônimo 2"]
}
```

`tussCode`, `ambCode`, `material` e `synonyms` são opcionais; ausentes ⇒ `null`/`[]`. Código
não confirmado é **`null`**, nunca inventado (D-081) — a tela também não inventa: campo vazio
grava `null`. `synonyms` é gravado na tabela filha `exam_synonyms` na mesma transação do POST.

**Response (201):**
```json
{
  "id": "uuid",
  "name": "Novo Exame",
  "code": "NE",
  "tussCode": "40304361",
  "ambCode": null,
  "material": "Sangue — tubo tampa roxa (EDTA)",
  "source": "manual",
  "synonyms": ["sinônimo 1", "sinônimo 2"],
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
  "material": "Sangue — tubo tampa amarela (gel separador)",
  "synonyms": ["sinônimo novo"],
  "isActive": false
}
```

Enviar `synonyms` **substitui o conjunto inteiro** (semântica de PUT sobre a coleção filha,
regravado na mesma transação do PATCH); omitir preserva os sinônimos atuais.

**Response (200):**
```json
{
  "id": "uuid",
  "pricePrivate": 110.00,
  "priceInsurance": 90.00,
  "material": "Sangue — tubo tampa amarela (gel separador)",
  "synonyms": ["sinônimo novo"],
  "isActive": false
}
```

### GET /exams/:id/prices
Preço do exame por convênio (todos do tenant).

**Response (200):**
```json
{
  "prices": [
    { "insuranceId": "8f2a1c4b-6d39-4f70-9a12-5c8e3b7d1f06", "price": 72.50 },
    { "insuranceId": "b1e2a1c4-6d39-4f70-9a12-5c8e3b7d1f07", "price": 68.00 }
  ]
}
```
Uma linha por convênio **cadastrado** para este exame — convênio sem preço definido para ele
simplesmente não aparece (é o caso que cai em `priceSource: "private"` no orçamento).

**Erros:** `NOT_FOUND` (exame inexistente ou de outro tenant)

### PUT /exams/:id/prices (manager/admin apenas)
Upsert em lote. **Semântica de PUT — estado completo**: linha ausente do corpo é **removida**.
Auditado (`update_exam_prices`).

**Request:**
```json
{
  "prices": [
    { "insuranceId": "8f2a1c4b-6d39-4f70-9a12-5c8e3b7d1f06", "price": 72.50 },
    { "insuranceId": "b1e2a1c4-6d39-4f70-9a12-5c8e3b7d1f07", "price": 68.00 }
  ]
}
```

**Response (200):** o mesmo shape do `GET` — o estado completo depois da escrita.
```json
{
  "prices": [
    { "insuranceId": "8f2a1c4b-6d39-4f70-9a12-5c8e3b7d1f06", "price": 72.50 },
    { "insuranceId": "b1e2a1c4-6d39-4f70-9a12-5c8e3b7d1f07", "price": 68.00 }
  ]
}
```

**Validações:** `price >= 0`; `insuranceId` precisa existir e estar ativo no tenant, senão
`VALIDATION_ERROR` (`details.fields["prices.<insuranceId>"]`); `insuranceId` repetido no array
→ `VALIDATION_ERROR`.

**Erros:** `NOT_FOUND` (exame de outro tenant), `VALIDATION_ERROR` (400, `details.fields`),
`FORBIDDEN` (403, `details.requiredRoles: ["manager","admin"]`)

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

### Entitlement por plano (Onda 9 — D-086/D-087)

A partir da migração `010_plans_basic_plus.sql`, `subscription_plan` só aceita dois valores:
`basic` e `plus` (substituem `starter`/`pro`/`enterprise` — D-086). `plus` é superconjunto de
`basic`: todo tenant `plus` enxerga tudo que um `basic` enxerga, mais o que a tabela abaixo lista
na coluna `plus`.

O plano viaja **dentro do JWT** (`JwtPayload.plan`) — nunca em header, query ou body do cliente —
e é copiado para `TenantContext.plan` por `requireAuth`. Um access token emitido **antes** desta
onda não carrega `plan`; `requirePlan` trata a ausência como `basic` (nunca como `plus`), então um
deploy em andamento nunca abre uma rota `plus` por engano.

`requirePlan('plus')`, usado ao lado de `requireRoles(...)` nos routers que exigem o plano
superior, falha com **`403 PLAN_REQUIRED`** e `details: { requiredPlan: "plus", currentPlan }`
(API_ERRORS.md). Diferente de `FORBIDDEN`: o papel do usuário pode estar correto — é o **plano do
tenant** que não cobre a rota.

| Plano mínimo | Backend (routers) | Frontend (rotas) |
|---|---|---|
| **basic** | `/auth`, `/users`, `/themes`, `/audit`, `/exams`, `/insurances`, `/platform` | `/catalog` (sem preço), `/settings/users`, `/settings/theme`, `/settings/insurances` |
| **plus** | `/conversations`, `/patients`, `/proposals`, `/internal-chat`, `/quick-replies`, `/media`, `/settings/channels`, `/operations`, `/analytics` | `/attendance`, `/patients/:id`, `/budget/new`, `/proposals`, `/analytics`, `/internal-chat`, `/quick-replies`, `/decisions`, `/settings/channels`, `/settings/operation` |

`/webhooks/*` é caso à parte: **público** (autenticado por HMAC, não por `plan`/`role`). Tenant
`basic` continua respondendo `200` ao gateway (nunca falha o webhook do provedor), mas a mensagem
recebida **não é processada** — `basic` não tem `/conversations`.

Rotas ainda não implementadas nesta onda (`/lis-imports`, `/lis-budgets`, `/sales`, `/attendants`,
`/settings/commissions`, `/reports/executive` no backend; `/results`, `/reconciliation`,
`/active-search`, `/sales`, `/settings/attendants`, `/settings/commissions` no frontend) entram no
mesmo quadro na Onda 10/11 — o quadro acima já reserva o lugar delas em `basic`.

### GET /platform/tenants

**Query Params:** `?page=1&limit=20&search=vida&isActive=true&plan=basic|plus`

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

**Response (201):** `TenantSummary` **cru** (D-070) — o mesmo shape de
`GET /platform/tenants`, tipado como `CreateTenantResponse` (alias de `TenantSummary`) em
`shared/types/platform.types.ts`. Sem envelope `{ "tenant": ... }`.
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

### GET /platform/tenants/:id

Detalhe de um laboratório (D-102). `:id` não-uuid → `400 VALIDATION_ERROR`. Tenant inexistente
(ou soft-deletado) → `404 NOT_FOUND` (mesma regra de sempre, nunca `403`).

**Response (200):** `TenantDetail` (`shared/types/platform.types.ts`) — o mesmo `TenantSummary`
de `GET /platform/tenants`, mais:

```json
{
  "id": "uuid", "name": "Laboratório Vida", "slug": "lab-vida", "isActive": true,
  "subscriptionPlan": "pro", "subscriptionUntil": "2026-12-31", "userCount": 8,
  "createdAt": "2026-01-10T12:00:00.000Z",
  "channels": [
    { "channel": "whatsapp", "isActive": true, "connectionMode": "cloud_api",
      "connectedAt": "2026-02-01T09:00:00.000Z" }
  ],
  "admins": [
    { "id": "uuid", "email": "admin@labvida.com.br" }
  ],
  "usage": {
    "activeUsers": 6, "totalUsers": 8, "lastLoginAt": "2026-09-08T18:22:00.000Z",
    "proposalsThisMonth": 44, "messagesThisMonth": 5250
  }
}
```

`channels` nunca inclui `phoneNumber`, `apiToken` ou `webhookSecret` (§6 abaixo — mesma proibição,
aqui o corte é ainda mais estreito: nem `phoneNumberId`/`phoneNumber` entram). `admins` só lista
usuários com `role: "admin"` — nunca `manager`/`attendant`, e nunca `name`. Laboratório sem canal
configurado → `channels: []`; sem admin (não deveria acontecer, onboarding sempre cria um, mas
não é impossível após edição manual) → `admins: []`.

### PATCH /platform/tenants/:id

Suspende/reativa o laboratório e/ou troca o plano (D-102). Corpo aceita `isActive` e/ou
`subscriptionPlan` — **ao menos um** dos dois, nunca os dois ausentes (`{}` → `400
VALIDATION_ERROR`). Campo desconhecido no corpo é recusado (schema `strict`).

**Request:**
```json
{ "isActive": false }
```
ou
```json
{ "subscriptionPlan": "enterprise" }
```
ou os dois juntos.

**Response (200):** `TenantSummary` cru, mesmo padrão sem envelope de `POST /platform/tenants`
(D-070).

**Erros:** `VALIDATION_ERROR` (400, corpo vazio ou `subscriptionPlan` fora do catálogo),
`NOT_FOUND` (404, tenant inexistente), `FORBIDDEN` (403, `platform_operator` é quem PODE chamar
esta rota — outro papel recebe `403` com `details.requiredRoles: ["platform_operator"]`, igual ao
resto de §5b).

Gera `audit_logs` (`action: "update_tenant"`) só quando algo de fato muda — `PATCH` que repete o
valor atual não grava linha nova (mesmo padrão diff-then-audit de `PATCH /users/:id`).
Desativar o tenant não derruba sessões já emitidas (`refresh_tokens` continuam válidos até
expirar/serem usados) — a checagem de `tenants.is_active` acontece no login
(`findLoginCandidatesByEmail`); revogar acesso imediato de sessão ativa não é escopo desta rota.

### POST /platform/tenants/:id/users/:userId/reset-password

Gera uma senha temporária para um admin do laboratório (D-102). Sem corpo. `:userId` precisa
pertencer ao **mesmo** `:id` **e** ter `role: "admin"` — qualquer outro caso (usuário de outro
tenant, usuário inexistente, ou `role` diferente de `admin`) responde `404 NOT_FOUND`, nunca
`403` (não vazar existência nem papel do usuário).

**Response (200):**
```json
{ "userId": "uuid", "email": "admin@labvida.com.br", "temporaryPassword": "kQ7f2m9Xp1zR" }
```

`temporaryPassword` aparece em texto plano **só nesta resposta, uma única vez** — não é
recuperável depois, não é logada (`audit_logs` grava `action: "reset_admin_password"` sem
`oldValues`/`newValues`, mesma regra de segredo nunca no payload do log de `POST
/platform/tenants`). Repassar a senha ao cliente é responsabilidade de quem opera o console, fora
do sistema.

**Erros:** `NOT_FOUND` (404), `VALIDATION_ERROR` (400, `:id`/`:userId` não-uuid), `FORBIDDEN`
(403, `platform_operator`).

---

## 6. Channel Settings (Canais & Equipe)

Tela `/settings/channels` (PAGES.md §10). Shapes em `shared/types/settings.types.ts`; tabelas
`tenant_channels` e `tenant_settings` (SCHEMA.md §15 e §16).

**Papéis:** `GET` é **gestor e admin** (a tela é leitura para o gestor). `PATCH` é **admin**.
`attendant` recebe `403 FORBIDDEN` com `details.requiredRoles: ["manager","admin"]` no `GET` e
`["admin"]` no `PATCH`; `platform_operator` recebe `403` em ambos.

### Segredo nunca volta na resposta

`apiToken` e `webhookSecret` são **write-only**. Nenhuma resposta desta seção — nem de nenhuma
outra — devolve o valor em claro, mascarado no meio, "só para o admin" ou "só logo depois de
salvar". A leitura expressa apenas:

| Campo da resposta | O que é |
|---|---|
| `apiTokenMasked` | `'••••••••' + últimos 4 caracteres` do token, ou `null` se não há token |
| `webhookSecretSet` | `true`/`false`. **Sem prévia**: o segredo é curto e assina HMAC, e mostrar 4 caracteres dele reduz o espaço de busca |

Vale também para log e audit log: `update_channel_settings` grava
`"apiToken": "[REDACTED]"` / `"webhookSecret": "[REDACTED]"` em `newValues`, nunca o valor.

### GET /settings/channels

**Response (200):** composta — cada bloco da tela é uma chave (regra de envelope).
```json
{
  "channels": [
    {
      "id": "b8e2a1c4-6d39-4f70-9a12-5c8e3b7d1f06",
      "channel": "whatsapp",
      "displayName": "WhatsApp do Vida",
      "phoneNumberId": "109876543210987",
      "phoneNumber": "+55 48 3621-0000",
      "isActive": true,
      "apiTokenMasked": "••••••••9f2a",
      "webhookSecretSet": true,
      "connectedAt": "2026-07-02T11:20:00.000Z",
      "updatedAt": "2026-08-19T08:45:00.000Z"
    }
  ],
  "distributionMode": "round_robin",
  "autoMessages": {
    "greeting": {
      "enabled": true,
      "message": "Olá! Somos o Laboratório Vida. Em que podemos ajudar?"
    },
    "offHours": {
      "enabled": true,
      "message": "Nosso atendimento é de segunda a sexta, das 8h às 18h. Retornamos em breve."
    }
  },
  "businessHours": {
    "timezone": "America/Sao_Paulo",
    "days": {
      "mon": { "start": "08:00", "end": "18:00" },
      "tue": { "start": "08:00", "end": "18:00" },
      "wed": { "start": "08:00", "end": "18:00" },
      "thu": { "start": "08:00", "end": "18:00" },
      "fri": { "start": "08:00", "end": "18:00" },
      "sat": { "start": "08:00", "end": "12:00" },
      "sun": null
    }
  },
  "team": [
    { "id": "4a1b8e6c-5d72-4931-b0f8-2e7a9c1d4b55", "name": "Maria Souza", "role": "attendant", "isActive": true },
    { "id": "7c3d5f92-1a48-4c60-8e21-9b5d7a3f2c11", "name": "Gestora Ana", "role": "manager", "isActive": true }
  ]
}
```

- `channels` traz **um item por canal configurado**; laboratório sem canal responde `[]` (não
  é erro, é o estado inicial). Ordem fixa por `channel ASC`.
- **Laboratório sem linha em `tenant_settings` recebe os defaults** — `distributionMode:
  "manual"`, as duas mensagens com `enabled: false` e `message: null`, `timezone:
  "America/Sao_Paulo"` e `days: {}` — sem que nada seja gravado. O onboarding não cria a linha;
  o primeiro `PATCH` cria (D-065).
- **`team` (D-066)** é a equipe do laboratório: usuários com papel `attendant`, `manager` ou
  `admin`, ordenados por `name ASC`, **incluindo inativos** (`isActive: false`) — o gestor
  precisa ver quem está fora do rodízio. `platform_operator` nunca aparece.
  O recorte é deliberadamente mínimo: id, nome, papel e status, **sem e-mail e sem alçada**.
  Assim a tela funciona para o gestor sem alargar `GET /users` (que é admin) e sem expor por
  uma tela de configuração o dado que a tela de usuários já governa.

**Erros:** `FORBIDDEN` (403, `details.requiredRoles: ["manager","admin"]` — ou
`["attendant","manager","admin"]` quando quem chama é `platform_operator`)

### PATCH /settings/channels (admin apenas)
PATCH parcial: chave ausente permanece. Corpo vazio (`{}`) ou campo desconhecido →
`VALIDATION_ERROR` (o schema é `strict`).

**Request:**
```json
{
  "channels": [
    {
      "channel": "whatsapp",
      "displayName": "WhatsApp do Vida",
      "phoneNumberId": "109876543210987",
      "phoneNumber": "+55 48 3621-0000",
      "isActive": true,
      "apiToken": "EAAG...token-em-claro",
      "webhookSecret": "um-segredo-de-no-minimo-16-chars"
    }
  ],
  "distributionMode": "round_robin",
  "autoMessages": {
    "greeting": { "enabled": true, "message": "Olá! Somos o Laboratório Vida." }
  },
  "businessHours": {
    "timezone": "America/Sao_Paulo",
    "days": { "mon": { "start": "08:00", "end": "18:00" }, "sun": null }
  }
}
```

**`channels[]` é upsert pela chave `channel`** (não pelo `id`): `UNIQUE (tenant_id, channel)`
garante uma linha por canal, e a tela edita "o WhatsApp do laboratório", não uma linha por id.
Canal ausente do array **não** é apagado — não existe remoção de canal nesta rota; desligar é
`isActive: false`.

Semântica dos segredos, em três estados:

| `apiToken` / `webhookSecret` no corpo | Efeito |
|---|---|
| ausente | preserva o valor guardado |
| `null` | **apaga** o segredo (`apiTokenMasked` volta a `null`, `webhookSecretSet` volta a `false`) |
| string | grava o novo valor |

String vazia (`""`) → `VALIDATION_ERROR`: apagar é `null`, explicitamente.

Validações:
- `channel` ∈ `whatsapp | sms | web | direct`; repetido no mesmo array → `VALIDATION_ERROR`
- `apiToken`: 10..500 caracteres · `webhookSecret`: 16..255 caracteres (abaixo disso o HMAC
  não vale nada) · `displayName` e `phoneNumberId` máx. 255 · `phoneNumber` máx. 30 — os
  quatro anuláveis
- `distributionMode` ∈ `manual | round_robin`
- `autoMessages`: PATCH parcial por mensagem (enviar só `greeting` preserva `offHours`).
  `enabled: true` com `message` nulo ou vazio → `VALIDATION_ERROR` com
  `details.fields["autoMessages.greeting.message"]` — mensagem automática ligada e vazia
  enviaria uma bolha em branco ao paciente. `message`: 1..1000 caracteres
- `businessHours`: `timezone` é IANA válido; dia ∈ `mon..sun`; `start`/`end` no formato `HH:MM`
  (24h) com `start < end` → senão `VALIDATION_ERROR`. **É substituição, não merge**: o objeto
  enviado vira o novo `businessHours` inteiro (dia omitido = fechado). Merge por dia deixaria
  impossível fechar um dia sem inventar um sentinela extra
- `connectedAt` é do servidor: preenchido na primeira gravação de `apiToken` e nunca aceito no
  corpo

Gera audit log `update_channel_settings` (`entityType: "tenant_settings"`, `entityId` = o
`tenantId`), com segredos redigidos.

**Response (200):** o mesmo shape do `GET` — o estado completo depois da escrita, já mascarado.

**Erros:** `VALIDATION_ERROR` (400, `details.fields`), `FORBIDDEN` (403,
`details.requiredRoles: ["admin"]`)

### 6.1 Conexão WhatsApp por QR (Evolution API, Onda 7 — Bloco B)

**Papéis:** as 4 rotas são **admin apenas**, `denyPlatformOperator()`, auditadas, no inventário
de isolamento. Fecham `TenantChannel.connectionMode: "qr"` (`shared/types/settings.types.ts`).
Ver D-083 (versão do gateway) e a nota de risco em `docs/architecture/SECURITY.md`.

**Indisponibilidade do gateway:** com `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` ou
`EVOLUTION_WEBHOOK_TOKEN` ausentes, as 4 rotas respondem `503` com `CHANNEL_QR_UNAVAILABLE` —
nunca crash (`ApiErrorCode` de `@crm-lab/shared`).

#### POST /settings/channels/whatsapp/connect
Cria (ou reaproveita, idempotente) a instância do tenant no gateway e devolve o QR.

**Request:**
```json
{ "acceptTerms": true }
```
Exige aceite prévio (`accepted_terms_at` já gravado) **ou** `acceptTerms: true` neste corpo —
faltando os dois, `VALIDATION_ERROR` (`details.fields.acceptTerms`). Quando o corpo traz
`acceptTerms: true`, o backend grava `accepted_terms_at = NOW()`, `accepted_terms_by =
<userId do ctx>` e o audit log `accept_whatsapp_qr_terms`, antes de falar com o gateway.

**Response (200):**
```json
{
  "qrcode": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
  "status": "pairing",
  "expiresInSeconds": 20
}
```
`qrcode` é `null` quando a instância já está `connected` (reconectar em canal já pareado devolve
o status atual em vez de um QR novo). Shape: `WhatsAppQrResponse`.

**Erros:** `VALIDATION_ERROR` (400, aceite ausente), `FORBIDDEN` (403,
`details.requiredRoles: ["admin"]`), `CHANNEL_QR_UNAVAILABLE` (503, gateway sem configuração ou
fora do ar)

#### GET /settings/channels/whatsapp/qr
QR vigente + status. É o endpoint que o modal faz **polling de ~2s** (até `connected` ou
timeout ~90s) enquanto o gateway renova o QR por trás (`QRCODE_UPDATED`, webhook).

**Response (200):**
```json
{
  "qrcode": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
  "status": "pairing",
  "expiresInSeconds": 14
}
```
Depois de conectado:
```json
{ "qrcode": null, "status": "connected", "expiresInSeconds": null }
```
Sem conexão iniciada (`connect` nunca chamado, ou desconectado): `{ "qrcode": null, "status":
"disconnected", "expiresInSeconds": null }`.

**Erros:** `FORBIDDEN` (403), `CHANNEL_QR_UNAVAILABLE` (503)

#### GET /settings/channels/whatsapp/status
Status do canal para o card de Canais & Equipe, sem QR — não faz polling.

**Response (200):**
```json
{
  "status": "connected",
  "phoneNumber": "+55 48 99999-0000",
  "connectedAt": "2026-08-30T11:20:00.000Z"
}
```
Shape: `WhatsAppStatusResponse`. Sem conexão: `{ "status": "disconnected", "phoneNumber": null,
"connectedAt": null }`.

**Erros:** `FORBIDDEN` (403), `CHANNEL_QR_UNAVAILABLE` (503)

#### POST /settings/channels/whatsapp/disconnect
Logout da instância no gateway + atualiza o canal (`is_active` inalterado — desconectar não é
desativar o canal na tela; são dois controles distintos).

**Response (204)** — sem corpo.

Também alcançável sem chamar esta rota: a pessoa remove o dispositivo no celular → o gateway
emite `loggedOut` pelo webhook → o CRM marca desconectado do mesmo jeito. A UI não distingue
desconexão voluntária de banimento — o termo de aceite avisa disso antecipadamente.

**Erros:** `FORBIDDEN` (403), `CHANNEL_QR_UNAVAILABLE` (503)

---

## 7. Operation (Gestão da Operação)

Tela `/settings/operation` (PAGES.md §10) — **somente leitura, gestor+**. Shapes em
`shared/types/operation.types.ts`.

**Papéis:** `manager` e `admin`. `attendant` → `403 FORBIDDEN` com
`details.requiredRoles: ["manager","admin"]` (a tela é de gestão de time: mostra a carga de
todos, e um atendente não enxerga a fila alheia em nenhum outro lugar do produto).
`platform_operator` → `403`.

**Tudo é derivado** de `conversations` e `proposals` a cada request (BUSINESS_RULES §5): nenhuma
tabela nova, nenhum número digitado, nenhum contador materializado. Sem cache — é um painel de
"agora", e 5 minutos de TTL mostrariam uma fila que já não existe.

**Tempos são inteiros de SEGUNDOS calculados dentro do SQL, em UTC (D-021):**
`EXTRACT(EPOCH FROM (NOW() - COALESCE(c.last_message_at, c.created_at)))::int`. As colunas são
`TIMESTAMP` sem timezone guardando UTC; se a subtração acontecesse em JavaScript, o driver
interpretaria a coluna no fuso da máquina e a espera sairia com horas de erro numa máquina em
UTC-3 — o mesmo defeito que a D-021 registrou em `daysOpen`. A formatação ("há 12 min") é do
frontend.

### GET /operations/overview
**Um** endpoint, não três (D-067): os três blocos da tela são um retrato do mesmo instante e
saem das mesmas duas tabelas. Três rotas triplicariam o polling e permitiriam a tela exibir uma
fila de 14:03 ao lado de uma carga de 14:05 — precisamente o tipo de incoerência que
BUSINESS_RULES §5 existe para evitar.

**Query Params:**
```
?queueLimit=25           // itens da fila devolvidos — default 25, máx. 100
?decisionsLimit=25       // decisões pendentes devolvidas — default 25, máx. 100
```
Acima do máximo → `VALIDATION_ERROR` (não é reduzido em silêncio).

**Response (200):**
```json
{
  "generatedAt": "2026-08-24T17:32:10.000Z",
  "queue": {
    "unassigned": 7,
    "waiting": 3,
    "oldestWaitSeconds": 5400,
    "items": [
      {
        "conversationId": "a7f3c2d1-4e58-49b6-8c02-7d1e5f9a3b64",
        "patientId": "3f1c9b0e-2d54-4a7b-9c11-8e2a6d5f4b30",
        "patientName": "João Santos",
        "channel": "whatsapp",
        "reason": "unassigned",
        "assignedTo": null,
        "assignedToName": null,
        "unreadCount": 2,
        "waitingSeconds": 5400,
        "lastMessageAt": "2026-08-24T16:02:10.000Z"
      },
      {
        "conversationId": "c1d9e4b7-3a26-4c85-9e10-6b4f2d8a7c33",
        "patientId": null,
        "patientName": "Ana Lima",
        "channel": "whatsapp",
        "reason": "waiting",
        "assignedTo": "4a1b8e6c-5d72-4931-b0f8-2e7a9c1d4b55",
        "assignedToName": "Maria Souza",
        "unreadCount": 1,
        "waitingSeconds": 780,
        "lastMessageAt": "2026-08-24T17:19:10.000Z"
      }
    ]
  },
  "workload": [
    {
      "userId": "4a1b8e6c-5d72-4931-b0f8-2e7a9c1d4b55",
      "name": "Maria Souza",
      "role": "attendant",
      "activeConversations": 12,
      "unreadMessages": 4,
      "openProposals": 5,
      "pendingApprovals": 1
    }
  ],
  "pendingDecisions": {
    "total": 2,
    "items": [
      {
        "proposalId": "6d9a4c2b-71e5-4f18-8b0a-3c5d2e9f1a44",
        "patientName": "João Santos",
        "createdBy": "4a1b8e6c-5d72-4931-b0f8-2e7a9c1d4b55",
        "createdByName": "Maria Souza",
        "status": "orcamento_enviado",
        "discountPercent": 25,
        "totalPrice": 150.00,
        "createdAt": "2026-08-24T14:40:00.000Z",
        "waitingSeconds": 10330
      }
    ],
    "pagination": { "page": 1, "limit": 25, "total": 2, "totalPages": 1 }
  }
}
```

**Definições — o que cada número significa, sem margem para interpretação:**

| Campo | Definição exata |
|---|---|
| `queue.unassigned` | conversas com `status = 'active'` e `assigned_to IS NULL` |
| `queue.waiting` | conversas com `status = 'active'`, `assigned_to IS NOT NULL` e `unread_count > 0` |
| `queue.oldestWaitSeconds` | maior `waitingSeconds` da fila **inteira**, não só dos itens listados. `null` quando a fila está vazia |
| `queue.items` | união das duas condições acima, `reason` dizendo qual delas casou, ordenada por `waitingSeconds DESC, conversationId ASC`, recortada por `queueLimit` |
| `waitingSeconds` | segundos desde `COALESCE(last_message_at, created_at)` |
| `workload[]` | uma linha por usuário **ativo** de papel `attendant`/`manager`/`admin`, ordenada por `name ASC`. Quem não tem carga aparece **zerado**, não some |
| `activeConversations` | conversas `active` atribuídas a ele |
| `unreadMessages` | soma de `unread_count` dessas conversas |
| `openProposals` | propostas criadas por ele em estágio **não terminal** (`TERMINAL_STATUSES` de `@crm-lab/shared`) |
| `pendingApprovals` | propostas criadas por ele com `approvalStatus = 'pending'` |
| `pendingDecisions` | propostas do tenant com `approvalStatus = 'pending'`, ordenadas por `createdAt ASC` (a mais velha primeiro — é uma fila de decisão), recortadas por `decisionsLimit` |

"Em espera" é `unread_count > 0` de propósito: é o mesmo número que o inbox mostra no badge, e
derivá-lo de "a última mensagem é do paciente" criaria uma segunda definição de "esperando
resposta" no mesmo produto — duas origens para o mesmo número.

`pendingDecisions.total` é a contagem completa (não o tamanho de `items`), e `pagination` é o
`PaginationMeta` padrão descrevendo **sempre a primeira página** (`page: 1`, `limit:
decisionsLimit`). **Este endpoint não pagina** (D-077): não existe `decisionsPage`, e o
`OperationOverviewQuery` não tem onde recebê-lo. O papel de `pagination` aqui é dizer à tela
*quantas decisões ficaram de fora* (`total`, `totalPages`) para ela oferecer o link "ver todas"
— a lista completa e paginável é `GET /proposals` filtrado por aprovação pendente. Um segundo
parâmetro de página não resolveria: a resposta é um retrato único do mesmo instante (D-067) e
pedir a página 2 das decisões refaz fila e carga junto.
`patientId` é `null` em conversa anterior ao backfill de D-059 — a tela só linka para a ficha
quando ele existe.

Este endpoint **não** aplica recorte por atendente: quem chega aqui é gestor ou admin, que já
enxergam todo o laboratório em `/conversations` e `/proposals`. Também **não** gera audit log:
é leitura.

**Erros:** `VALIDATION_ERROR` (400, `queueLimit`/`decisionsLimit` fora da faixa),
`FORBIDDEN` (403, `details.requiredRoles: ["manager","admin"]`)

---

## 8. Insurances (Convênios)

Tela `/settings/insurances` (PAGES.md §10). Módulo novo `/insurances`, mesmo padrão de
`/exams`. Shapes em `shared/types/insurance.types.ts`; tabela `insurances` (SCHEMA.md §18).
Ver D-081/D-082 em `docs/DECISIONS.md`.

**Papéis:** `GET` é para **todos os papéis do tenant** (é o que alimenta o seletor de convênio
em `/budget/new`, usado por qualquer atendente). `POST` e `PATCH` são **manager/admin**.
`platform_operator` → `403` nas três (`denyPlatformOperator()`); rota entra no inventário de
isolamento (`route-tenant-isolation.spec.ts`).

**"Particular" não é uma linha desta tabela** — é a ausência de convênio (`insuranceId: null`
em `POST /proposals`, §3). Um convênio fantasma "Particular" exigiria espelhar `pricePrivate`
em `exam_prices`, criando uma segunda origem para o mesmo número (D-082).

Não existe `DELETE /insurances/:id`: desativar é `PATCH { "isActive": false }` — mesmo padrão
de `/exams` (D-004: preço histórico de propostas antigas referencia o convênio usado).

### GET /insurances

**Query Params:**
```
?active=true              // omitido = ativos e inativos
?search=unimed            // casa NOME e RAZÃO SOCIAL, sem caixa nem acento
?page=1&limit=20          // default page=1, limit=20, máximo 100
?sortBy=name&order=asc    // sortBy: name|type|createdAt|updatedAt
```

**Response (200):**
```json
{
  "insurances": [
    {
      "id": "8f2a1c4b-6d39-4f70-9a12-5c8e3b7d1f06",
      "name": "Unimed Tubarão",
      "officialName": "Unimed de Tubarão Cooperativa de Trabalho Médico",
      "ansCode": "364860",
      "type": "cooperativa",
      "isActive": true,
      "createdAt": "2026-08-30T10:00:00.000Z",
      "updatedAt": "2026-08-30T10:00:00.000Z"
    },
    {
      "id": "b1e2a1c4-6d39-4f70-9a12-5c8e3b7d1f07",
      "name": "SC Saúde",
      "officialName": "Sistema de Assistência à Saúde dos Servidores de SC",
      "ansCode": null,
      "type": "especial",
      "isActive": true,
      "createdAt": "2026-08-30T10:00:00.000Z",
      "updatedAt": "2026-08-30T10:00:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 21, "totalPages": 2 }
}
```

**Erros:** nenhum específico (autenticado + do tenant já basta).

### POST /insurances (manager/admin apenas)
Criar convênio.

**Request:**
```json
{
  "name": "Bradesco Saúde",
  "officialName": "Bradesco Saúde S.A.",
  "ansCode": "005711",
  "type": "seguradora"
}
```
`officialName` e `ansCode` são opcionais (nem todo convênio regional tem registro ANS
confirmado — D-081). `type` ∈ `cooperativa | medicina_grupo | seguradora | autogestao |
especial`.

**Response (201):**
```json
{
  "id": "c2f3b5d6-7e40-4a81-8b13-6d9f4c8e2a17",
  "name": "Bradesco Saúde",
  "officialName": "Bradesco Saúde S.A.",
  "ansCode": "005711",
  "type": "seguradora",
  "isActive": true,
  "createdAt": "2026-08-30T10:05:00.000Z",
  "updatedAt": "2026-08-30T10:05:00.000Z"
}
```

Gera audit log `create_insurance`.

**Erros:** `CONFLICT` (409, `name` duplicado no tenant — corrida coberta por
`isUniqueViolation`, mesmo padrão de `/exams`), `VALIDATION_ERROR` (400, `details.fields`),
`FORBIDDEN` (403, `details.requiredRoles: ["manager","admin"]`)

### PATCH /insurances/:id (manager/admin apenas)
Atualizar convênio, inclusive desativar.

**Request:**
```json
{ "isActive": false }
```

**Response (200):**
```json
{
  "id": "c2f3b5d6-7e40-4a81-8b13-6d9f4c8e2a17",
  "name": "Bradesco Saúde",
  "officialName": "Bradesco Saúde S.A.",
  "ansCode": "005711",
  "type": "seguradora",
  "isActive": false,
  "createdAt": "2026-08-30T10:05:00.000Z",
  "updatedAt": "2026-08-30T10:06:00.000Z"
}
```

Gera audit log `update_insurance`.

**Erros:** `NOT_FOUND` (convênio de outro tenant), `CONFLICT` (409, renomear para nome já
usado), `VALIDATION_ERROR` (400, `details.fields`), `FORBIDDEN` (403,
`details.requiredRoles: ["manager","admin"]`)

---

## 9. Quick Replies (Respostas rápidas)

Textos prontos que a atendente dispara no Composer digitando `/atalho` (Onda 8 §3). São
**do laboratório**, não de quem escreveu: qualquer papel de tenant cria, edita e apaga.

`shortcut` é o que se digita depois da `/` — minúsculo, sem acento e sem espaço
(`^[a-z0-9-]{2,32}$`). O formato é validado, não sugerido: `/Horário Coleta` seria um
atalho que ninguém consegue digitar sem errar.

`platform_operator` não tem caminho para nenhuma destas rotas (PAGES.md §11).

### GET /api/v1/quick-replies
Todas as respostas rápidas do laboratório. Sem paginação: a lista alimenta o menu do
Composer, que precisa dela inteira para filtrar enquanto se digita, e o teto do CHECK
(`shortcut` de 32 caracteres) não é o que limita — o que limita é o uso: uma equipe com
centenas de macros já perdeu a macro.

**Roles:** `attendant`, `manager`, `admin`

**Response (200):**
```json
{
  "quickReplies": [
    {
      "id": "b0b1c2d3-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
      "shortcut": "horariocoleta",
      "title": "Horário de coleta",
      "content": "Nossa coleta é de segunda a sexta, das 6h30 às 11h, sem agendamento.",
      "createdBy": "9f8e7d6c-5b4a-4392-8180-7f6e5d4c3b2a",
      "createdAt": "2026-09-06T12:00:00.000Z",
      "updatedAt": "2026-09-06T12:00:00.000Z"
    }
  ]
}
```

Ordenado por `shortcut` (asc). Envelope de listagem sem `pagination` — é a exceção
explícita ao D-070 que esta seção registra, e a razão está no parágrafo acima.

`createdBy` é `null` quando o usuário que criou a macro foi removido
(`ON DELETE SET NULL`): a macro é do laboratório e sobrevive a quem a escreveu.

**Erros:** `FORBIDDEN` (403, `platform_operator`), `UNAUTHORIZED` (401)

### POST /api/v1/quick-replies
**Roles:** `attendant`, `manager`, `admin`

**Request:**
```json
{
  "shortcut": "horariocoleta",
  "title": "Horário de coleta",
  "content": "Nossa coleta é de segunda a sexta, das 6h30 às 11h, sem agendamento."
}
```

| Campo | Regra |
|-------|-------|
| `shortcut` | obrigatório, `^[a-z0-9-]{2,32}$`, único no tenant |
| `title` | obrigatório, 1–120 caracteres |
| `content` | obrigatório, 1–2000 caracteres |

**Response (201):** o objeto cru (recurso único — D-070), mesmo shape da listagem.

Gera audit log `create_quick_reply`.

**Erros:** `VALIDATION_ERROR` (400) — inclusive para atalho repetido no tenant, com
`details.fields.shortcut`; **não** é `CONFLICT`, porque o que a pessoa precisa corrigir é
um campo do formulário, e não um estado do servidor. `FORBIDDEN` (403,
`platform_operator`), `UNAUTHORIZED` (401)

### PATCH /api/v1/quick-replies/:id
Atualização parcial. Qualquer subconjunto de `shortcut`, `title`, `content`; corpo vazio
devolve a macro inalterada.

**Roles:** `attendant`, `manager`, `admin`

**Request:**
```json
{ "content": "Coleta de segunda a sexta, das 6h30 às 11h. Jejum de 8h para glicemia." }
```

**Response (200):** o objeto cru, com `updatedAt` novo.

Gera audit log `update_quick_reply` (só quando algum valor mudou de fato).

**Erros:** `NOT_FOUND` (404 — inexistente ou de outro tenant, nunca `FORBIDDEN`),
`VALIDATION_ERROR` (400, formato ou atalho repetido), `FORBIDDEN` (403,
`platform_operator`), `UNAUTHORIZED` (401)

### DELETE /api/v1/quick-replies/:id
Apaga de verdade — diferente de convênio e exame, que só desativam. Macro não é
referenciada por proposta nem por histórico: o texto já foi copiado para a mensagem
enviada no momento do uso.

**Roles:** `attendant`, `manager`, `admin`

Restringir a exclusão a gestor foi considerado e descartado: são textos de trabalho,
versionados no audit log, e travar a exclusão só produziria uma lista suja que ninguém
limpa.

**Response:** `204 No Content`

Gera audit log `delete_quick_reply` com o conteúdo apagado em `oldValues` — é o que torna
a exclusão reversível por uma pessoa, já que a linha não fica.

**Erros:** `NOT_FOUND` (404), `VALIDATION_ERROR` (400, `:id` não-uuid), `FORBIDDEN` (403,
`platform_operator`), `UNAUTHORIZED` (401)

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
socket.on('internal_chat.new_message', (data) => {...})
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

