# 💾 Schema do Banco de Dados

Estrutura completa das tabelas e relacionamentos do PostgreSQL.

---

## Diagrama ER (Entity Relationship)

```
┌─────────────────────────────────────────────────────────────────┐
│                         MULTITENANT                              │
└─────────────────────────────────────────────────────────────────┘

    ┌─────────────┐
    │   tenants   │ (laboratórios)
    ├─────────────┤
    │ id (pk)     │
    │ name        │
    │ slug        │
    │ (tema 1:1   │ ──┐
    │  via themes │   │
    │  .tenant_id)│   │
    │ logo_url    │   │
    │ created_at  │   │
    └─────┬───────┘   │
          │           │
          │ 1:N       │ 1:1
          │           │
    ┌─────┴───────┐   │
    │   users     │   │
    │   (1:N)     │   │
    └─────┬───────┘   │
          │           │
          │           │  ┌─────────────┐
          │           └─→│   themes    │
          │               ├─────────────┤
          │               │ id (pk)     │
          │               │ tenant_id   │
          │               │ name        │
          │               │ accent      │
          │               │ accent_2    │
          │               │ bg          │
          │               │ surface     │
          │               │ text        │
          │               │ font_id     │
          │               │ radius_id   │
          │               │ created_at  │
          │               └─────────────┘
          │
    ┌─────┴───────────────────────────────────────────┐
    │                   1:N                            │
    │                                                  │
    ▼                                                  ▼
┌──────────────┐  1:N          ┌──────────────────┐
│   users      │──────────────→│  conversations   │
├──────────────┤               ├──────────────────┤
│ id (pk)      │               │ id (pk)          │
│ tenant_id    │ (FK)          │ tenant_id        │ (FK)
│ email        │               │ patient_phone    │
│ name         │               │ patient_name     │
│ role         │ (atendente... │ assigned_to      │ (FK) User
│ discount_lim │               │ last_message_at  │
│ is_active    │               │ status           │ (ativo/arquivado)
│ created_at   │               │ created_at       │
└──────────────┘               └────────┬────────┘
                                        │
                                        │ 1:N
                                        ▼
                               ┌──────────────────┐
                               │   messages       │
                               ├──────────────────┤
                               │ id (pk)          │
                               │ conversation_id  │ (FK)
                               │ tenant_id        │ (FK)
                               │ sender_type      │ (patient/agent/system)
                               │ sender_id        │ (FK) User (nullable)
                               │ content          │
                               │ message_type     │ (text/image/audio/doc)
                               │ status           │ (sent/read/failed)
                               │ read_at          │
                               │ created_at       │
                               └──────────────────┘


┌──────────────────────────────────────────────┐
│            PROPOSTAS (ORÇAMENTOS)             │
└──────────────────────────────────────────────┘

    ┌──────────────┐    1:N        ┌───────────────────┐
    │conversations│───────────────→│   proposals       │
    └──────────────┘               ├───────────────────┤
                                   │ id (pk)           │
                                   │ tenant_id         │ (FK)
                                   │ conversation_id   │ (FK)
                                   │ created_by        │ (FK) User
                                   │ status            │ (novo_contato...)
                                   │ discount_percent  │
                                   │ total_price       │ (calculado)
                                   │ reason_lost       │ (se status=perdido)
                                   │ approved_by       │ (FK) User (nullable)
                                   │ approval_status   │ (pending/approved/rejected)
                                   │ created_at        │
                                   │ updated_at        │
                                   └────────┬──────────┘
                                            │
                                            │ 1:N
                                            ▼
                               ┌───────────────────────┐
                               │  proposal_items       │
                               ├───────────────────────┤
                               │ id (pk)               │
                               │ proposal_id           │ (FK)
                               │ exam_id               │ (FK)
                               │ quantity              │
                               │ unit_price            │
                               │ exam_name             │ (snapshot)
                               │ created_at            │
                               └───────────────────────┘


┌──────────────────────────────────────────────┐
│         CATÁLOGO DE EXAMES                    │
└──────────────────────────────────────────────┘

    ┌───────────────┐    1:N        ┌────────────────┐
    │   tenants     │───────────────→│  exam_catalog  │
    └───────────────┘               ├────────────────┤
                                    │ id (pk)        │
                                    │ tenant_id      │ (FK)
                                    │ name           │
                                    │ code           │
                                    │ description    │
                                    │ preparation    │
                                    │ turnaround_hrs │
                                    │ price_private  │
                                    │ price_insurance│
                                    │ is_active      │
                                    │ created_at     │
                                    │ updated_at     │
                                    └────────────────┘


┌──────────────────────────────────────────────┐
│         AUDITORIA & LOGS                      │
└──────────────────────────────────────────────┘

    ┌──────────────┐    1:N        ┌────────────────┐
    │   users      │───────────────→│ audit_logs     │
    └──────────────┘               ├────────────────┤
                                   │ id (pk)        │
                                   │ tenant_id      │ (FK)
                                   │ user_id        │ (FK)
                                   │ action         │
                                   │ entity_type    │
                                   │ entity_id      │
                                   │ old_values     │ (JSON)
                                   │ new_values     │ (JSON)
                                   │ ip_address     │
                                   │ user_agent     │
                                   │ timestamp      │
                                   └────────────────┘
```

---

## Tabelas Detalhadas

> **Correções aplicadas (D-012 / migração 001):**
> - `ON SET NULL` → `ON DELETE SET NULL` (a forma original não é SQL válido) —
>   `conversations.assigned_to`, `messages.sender_id`, `proposals.approved_by`, `audit_logs.user_id`
> - a coluna `tenants.theme_id` e sua FK circular para `themes(id)` foram **removidas**:
>   `themes.tenant_id` já é `UNIQUE` e modela o 1:1 sem exigir criação em duas fases
> - `proposal_items` ganhou coluna `tenant_id` própria (D-002 / Contrato 2 do AGENTS.md)
> - `proposals.total_price` continua `NOT NULL` — é cache calculado pelo backend (D-003)
> - onde a tabela declara `updated_at`, a migração cria também o trigger
>   `trg_<tabela>_updated_at` sobre a função `set_updated_at()`

### 1. `tenants`
Cada laboratório é um tenant separado.

```sql
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  logo_url VARCHAR(500),
  is_active BOOLEAN DEFAULT TRUE,
  subscription_plan VARCHAR(50) DEFAULT 'starter', -- starter, pro, enterprise
  subscription_until DATE,
  extra_messages INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP NULL
);

CREATE INDEX idx_tenants_slug ON tenants(slug);
CREATE INDEX idx_tenants_active ON tenants(is_active);
```

### 2. `users`
Usuários dentro de um tenant.

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL, -- 'attendant', 'manager', 'admin', 'platform_operator'
  discount_limit_percent INT DEFAULT 15, -- máximo desconto permitido
  is_active BOOLEAN DEFAULT TRUE,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE(tenant_id, email),
  CHECK (role IN ('attendant', 'manager', 'admin', 'platform_operator'))
);

CREATE INDEX idx_users_tenant_id ON users(tenant_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_active ON users(is_active);
```

### 3. `conversations`
Chats com pacientes (WhatsApp, SMS, etc).

```sql
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  patient_phone VARCHAR(20) NOT NULL,
  patient_name VARCHAR(255),
  patient_email VARCHAR(255),
  assigned_to UUID, -- User ID
  channel VARCHAR(50), -- 'whatsapp', 'sms', 'web', 'direct'
  status VARCHAR(50) DEFAULT 'active', -- active, archived, closed
  last_message_at TIMESTAMP,
  unread_count INT DEFAULT 0,
  tags JSONB DEFAULT '[]',
  custom_fields JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_conversations_tenant_id ON conversations(tenant_id);
CREATE INDEX idx_conversations_assigned_to ON conversations(assigned_to);
CREATE INDEX idx_conversations_created_at ON conversations(created_at);
CREATE INDEX idx_conversations_phone ON conversations(patient_phone);
```

### 4. `messages`
Mensagens dentro de uma conversa.

```sql
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  sender_type VARCHAR(50) NOT NULL, -- 'patient', 'agent', 'system'
  sender_id UUID, -- User ID (nullable para patient/system)
  content TEXT NOT NULL,
  message_type VARCHAR(50) DEFAULT 'text', -- text, image, audio, pdf, etc
  attachment_url VARCHAR(500),
  status VARCHAR(50) DEFAULT 'sent', -- sent, delivered, read, failed
  external_message_id VARCHAR(255), -- ID da API externa (WhatsApp, etc)
  read_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_status ON messages(status);
```

### 5. `proposals`
Orçamentos/Propostas.

```sql
CREATE TABLE proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  created_by UUID NOT NULL, -- User ID
  status VARCHAR(50) NOT NULL DEFAULT 'novo_contato',
  -- Valores: novo_contato, orcamento_enviado, follow_up, negociacao, ganho, perdido
  
  discount_percent NUMERIC(5,2) DEFAULT 0,
  total_price NUMERIC(12,2) NOT NULL,
  reason_lost VARCHAR(255), -- motivo se status = perdido
  
  approval_status VARCHAR(50) DEFAULT 'none', -- none, pending, approved, rejected
  approved_by UUID, -- User ID
  approved_at TIMESTAMP,
  
  sent_at TIMESTAMP,
  closed_at TIMESTAMP,
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (status IN ('novo_contato', 'orcamento_enviado', 'follow_up', 'negociacao', 'ganho', 'perdido')),
  CHECK (discount_percent >= 0 AND discount_percent <= 100)
);

CREATE INDEX idx_proposals_tenant_id ON proposals(tenant_id);
CREATE INDEX idx_proposals_conversation_id ON proposals(conversation_id);
CREATE INDEX idx_proposals_status ON proposals(status);
CREATE INDEX idx_proposals_created_at ON proposals(created_at);
```

### 6. `proposal_items`
Itens dentro de uma proposta (exames selecionados).

**`tenant_id`:** coluna própria, redundante com `proposals.tenant_id` de propósito. Sem ela a
policy de RLS precisaria de um `EXISTS` na proposta a cada linha lida, e a tabela violaria a regra
"`tenant_id` é obrigatório em toda tabela de dados de laboratório" (AGENTS.md, Contrato 2).
O service preenche sempre com o `tenant_id` da proposta pai.

```sql
CREATE TABLE proposal_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,          -- D-002: obrigatório em toda tabela de dados
  proposal_id UUID NOT NULL,
  exam_id UUID NOT NULL,
  quantity INT DEFAULT 1,
  unit_price NUMERIC(12,2) NOT NULL,
  
  -- Snapshot do nome do exame (para histórico)
  exam_name VARCHAR(255) NOT NULL,
  
  created_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE,
  FOREIGN KEY (exam_id) REFERENCES exam_catalog(id),
  CHECK (quantity > 0)
);

CREATE INDEX idx_proposal_items_proposal_id ON proposal_items(proposal_id);
CREATE INDEX idx_proposal_items_tenant_id ON proposal_items(tenant_id);
```

### 7. `exam_catalog`
Catálogo de exames por laboratório.

```sql
CREATE TABLE exam_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(50) NOT NULL,
  description TEXT,
  preparation TEXT,
  turnaround_hours INT,
  price_private NUMERIC(12,2) NOT NULL,
  price_insurance NUMERIC(12,2) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  category VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE(tenant_id, code)
);

CREATE INDEX idx_exam_catalog_tenant_id ON exam_catalog(tenant_id);
CREATE INDEX idx_exam_catalog_active ON exam_catalog(is_active);
```

### 8. `themes`
Temas/Personalização visual por tenant.

```sql
CREATE TABLE themes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  accent VARCHAR(7) NOT NULL, -- hex color
  accent_2 VARCHAR(7) NOT NULL,
  bg VARCHAR(7) NOT NULL,
  surface VARCHAR(7) NOT NULL,
  text VARCHAR(7) NOT NULL,
  font_id VARCHAR(50) DEFAULT 'figtree', -- figtree, etc
  radius_id VARCHAR(50) DEFAULT 'md', -- sm, md, lg (reto/suave/redondo)
  brand_name VARCHAR(255),
  logo_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX idx_themes_tenant_id ON themes(tenant_id);
```

### 9. `audit_logs`
Auditoria de todas as ações (multitenant).

```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID,
  action VARCHAR(100) NOT NULL, -- create, update, delete, approve, etc
  entity_type VARCHAR(50) NOT NULL, -- proposal, conversation, user, etc
  entity_id UUID NOT NULL,
  old_values JSONB,
  new_values JSONB,
  ip_address VARCHAR(50),
  user_agent VARCHAR(500),
  timestamp TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_audit_logs_tenant_id ON audit_logs(tenant_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp);
```

---

### 10. `proposal_status_history`
Histórico de mudanças de estágio de uma proposta. É a origem do campo `history` de
`GET /proposals/:id` (`docs/api/API_CONTRACTS.md`). Acrescentada por D-012c.

```sql
CREATE TABLE proposal_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  proposal_id UUID NOT NULL,
  status VARCHAR(50) NOT NULL,
  changed_by UUID,                       -- User ID (nullable: mudança do sistema)
  changed_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (status IN ('novo_contato', 'orcamento_enviado', 'follow_up', 'negociacao', 'ganho', 'perdido'))
);

CREATE INDEX idx_proposal_status_history_proposal ON proposal_status_history(proposal_id, changed_at);
CREATE INDEX idx_proposal_status_history_tenant_id ON proposal_status_history(tenant_id);
```

O ProposalService grava uma linha a cada transição aceita (inclusive a criação, com
`novo_contato`). A ordenação do `history` na resposta é `changed_at ASC`.

---

### 11. `internal_channels`
Canais e DMs do chat interno do laboratório (`docs/backend/SERVICES.md` §7).
Canais padrão criados no onboarding: `#geral` e `#aprovacoes`.

```sql
CREATE TABLE internal_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  key VARCHAR(100) NOT NULL,                   -- 'geral', 'aprovacoes' ou chave da DM
  name VARCHAR(255) NOT NULL,                  -- '#geral'
  kind VARCHAR(20) NOT NULL DEFAULT 'channel', -- channel | dm
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, key),
  CHECK (kind IN ('channel', 'dm'))
);

CREATE INDEX idx_internal_channels_tenant_id ON internal_channels(tenant_id);
```

`UNIQUE (tenant_id, key)` é o que permite ao `createSystemPost(tenantId, channelKey, ...)`
resolver o canal pela chave sem ambiguidade.

---

### 12. `internal_messages`
Mensagens dos canais internos.

```sql
CREATE TABLE internal_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  sender_id UUID,                       -- NULL quando is_system = TRUE
  content TEXT NOT NULL,
  attached_proposal_id UUID,            -- renderiza como cartão no frontend
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES internal_channels(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (attached_proposal_id) REFERENCES proposals(id) ON DELETE SET NULL
);

CREATE INDEX idx_internal_messages_channel_created ON internal_messages(channel_id, created_at DESC);
CREATE INDEX idx_internal_messages_tenant_id ON internal_messages(tenant_id);
```

---

### 13. `refresh_tokens`
Refresh tokens do AuthService, guardados **hasheados** (nunca em claro).

```sql
CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP,                 -- logout / rotação
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_tenant_id ON refresh_tokens(tenant_id);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
```

Token válido = `revoked_at IS NULL AND expires_at > NOW()`.

---

## Row-Level Security (RLS) — implementado em `002_row_level_security.sql`

O isolamento multitenant não é convenção: é imposto pelo banco. O backend conecta com o papel
**`crm_app`**, que **não é dono das tabelas** — por isso o RLS se aplica a ele (donos e
superusuários burlam RLS). A cada request, o middleware de tenant abre a transação com:

```sql
SET LOCAL app.tenant_id = '<uuid do tenant do JWT>';
```

### Papel da aplicação

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    CREATE ROLE crm_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crm_app;

-- tabelas de migrações futuras herdam os mesmos GRANTs
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;
```

### Policy padrão (uma por tabela com `tenant_id`)

```sql
ALTER TABLE <tabela> ENABLE ROW LEVEL SECURITY;
CREATE POLICY <tabela>_tenant_isolation ON <tabela>
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

- `current_setting('app.tenant_id', **true**)` → retorna `NULL` em vez de erro quando a variável
  nunca foi setada
- `NULLIF(..., '')` → cobre o caso de string vazia (`RESET`, `SET ... = ''`)
- sem contexto de tenant a comparação vira `NULL`: **nenhuma linha visível, nenhum INSERT aceito**
  (fail-closed)
- `WITH CHECK` é o que impede gravar linha de outro tenant (verificado nos testes)

### `tenants` também está sob RLS

A tabela raiz não tem coluna `tenant_id` — a chave do próprio tenant é `id`:

```sql
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_self_isolation ON tenants
  FOR ALL
  USING      (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

Sem essa policy, `crm_app` tem `SELECT` na tabela e qualquer caminho de código que esquecesse o
filtro — ou uma injeção de SQL em endpoint autenticado — enumeraria todos os laboratórios
clientes (nome, slug, plano, data de assinatura). Vazamento entre concorrentes, e a camada 3 da
defesa em profundidade de `docs/architecture/SECURITY.md` ficaria aberta justamente na tabela raiz.
BUSINESS_RULES.md §4 não abre exceção.

Dentro de uma transação **com** contexto, tudo que o sistema legitimamente faz continua
funcionando: carregar o próprio tenant no payload de login, joins `users → tenants`, a tela de
Personalização. O que passa a ser impossível é enxergar tenant alheio.

### As duas exceções que rodam fora do contexto de tenant

Dois caminhos precisam, por definição, ver mais de um tenant. Ambos passam pelo `withoutTenant()`
do Kernel, que executa como **dono das tabelas** (donos burlam RLS) — nomeado assim de propósito
para ser a exceção visível e auditável, nunca o caminho normal:

| Caminho | Por quê |
|---------|---------|
| **Login** | busca o usuário por email **antes** de saber a qual tenant ele pertence |
| **Console da plataforma** | opera sobre todos os tenants por definição (`platform_operator`) |

Nenhum outro caminho de código deve usar `withoutTenant()`.

### Cobertura

| Tabela | RLS | Observação |
|--------|-----|------------|
| `tenants` | ✅ | policy pela coluna **`id`** (a chave do próprio tenant), não `tenant_id` |
| `users` | ✅ | |
| `conversations` | ✅ | |
| `messages` | ✅ | |
| `exam_catalog` | ✅ | |
| `proposals` | ✅ | |
| `proposal_items` | ✅ | via `tenant_id` próprio |
| `proposal_status_history` | ✅ | |
| `themes` | ✅ | |
| `audit_logs` | ✅ | |
| `internal_channels` | ✅ | |
| `internal_messages` | ✅ | |
| `refresh_tokens` | ✅ | |

Verificado em PGlite (D-008) com 2 tenants, nas **13** tabelas: com `app.tenant_id` = tenant A,
nenhuma linha do tenant B aparece em `SELECT`/`UPDATE`/`DELETE`; `SELECT * FROM tenants` devolve
exatamente 1 linha (a de A); `INSERT` com `tenant_id` (ou `id`) de B é rejeitado pelo `WITH CHECK`;
sem `app.tenant_id` setado, todas as tabelas devolvem 0 linhas. O mesmo SQL roda em Postgres 16
no docker.

---

## Índices para Performance

Principais índices (já criados acima):

```sql
-- Multitenant queries
CREATE INDEX idx_conversations_tenant_created ON conversations(tenant_id, created_at DESC);
CREATE INDEX idx_proposals_tenant_status ON proposals(tenant_id, status);

-- User queries
CREATE INDEX idx_users_tenant_email ON users(tenant_id, email);

-- Sorting/Filtering
CREATE INDEX idx_messages_conversation_created ON messages(conversation_id, created_at DESC);
CREATE INDEX idx_proposals_conversation_id ON proposals(conversation_id); -- já criado na seção 5

-- Search (busca por nome de paciente)
CREATE INDEX idx_conversations_patient_name
  ON conversations USING GIN (to_tsvector('portuguese', COALESCE(patient_name, '')));
```

`patient_name` é nullable; o `COALESCE` mantém a expressão indexável para toda linha (e a query de
busca deve usar exatamente a mesma expressão para o índice ser aproveitado).

---

## Migrações

Todas as migrações estão em `backend/migrations/`:

```
migrations/
├── 001_initial_schema.sql        # todas as 13 tabelas + índices + triggers de updated_at
├── 002_row_level_security.sql    # papel crm_app + GRANTs + policies por tenant_id
└── ...
```

Rodar migrações:
```bash
npm run migrate
# ou
npm run migrate:up
```

---

## Seed Data

Implementado em `backend/src/db/seeds/` (não `backend/seeds/`: o CLI
`src/db/cli/seed.ts` importa `src/db/seeds/index.ts`).

```bash
npm run seed        # dataset de desenvolvimento
npm run seed:e2e    # dataset determinístico do Playwright
```

### Como o seed escreve

Roda inteiro dentro de **`db.withoutTenant()`** — exceção auditada e deliberada:
o seed *cria* os tenants, então não existe `app.tenant_id` para setar, e as
policies RLS (fail-closed) rejeitariam todo `INSERT`. Cada linha carrega seu
`tenant_id` explícito; `backend/tests/seeds/` varre todas as FKs cross-tenant
para provar que nenhuma linha de um tenant referencia entidade de outro.

**Idempotência: limpa e recria.** O seed dá `TRUNCATE ... RESTART IDENTITY
CASCADE` em todas as tabelas de dados (menos `schema_migrations`) e reescreve —
não usa upsert, porque um upsert parcial produziria um retrato meio velho e meio
novo do funil. Todos os IDs são derivados por hash de um nome estável
(`seedUuid`), então rodar duas vezes deixa o banco idêntico, com os mesmos IDs.
Em `NODE_ENV=production` o comando **recusa rodar** e não toca em nada
(`SeedRefusedError`).

Senhas usam `hashPassword()` de `src/lib/password.ts` (bcrypt real), nunca hash
literal.

### Dataset de desenvolvimento (`npm run seed`)

**3 tenants** — 2 laboratórios com temas **diferentes** (se o tema de um vazar
para o outro, aparece na hora) + o tenant da plataforma:

| Tenant | Slug | Tema | Conteúdo |
|--------|------|------|----------|
| Laboratório Vida | `lab-vida` | Terracota & Sálvia | 82 exames · 90 conversas · 33 propostas |
| Laboratório Central | `lab-central` | Azul Jaleco | 24 exames · 24 conversas · 11 propostas |
| Plataforma CRM Lab | `plataforma` | — | só o `platform_operator` |

O `platform_operator` mora no **próprio tenant**, sem dado nenhum de
laboratório: `users.tenant_id` é `NOT NULL`, então o schema não tem usuário "sem
tenant"; o console da plataforma opera via `withoutTenant()`, não pelo RLS.

**Usuários** (senha `senha123` para todos; impressa no fim do seed), com os
limites de `DEFAULT_DISCOUNT_LIMIT` de `@crm-lab/shared`:

| E-mail | Papel | Alçada |
|--------|-------|--------|
| `admin@labvida.com.br` | admin | 100% |
| `gestor@labvida.com.br` | manager | 30% |
| `maria@labvida.com.br` | attendant | 15% |
| `joao@labvida.com.br` | attendant | 15% |
| `admin@labcentral.com.br` · `gestor@labcentral.com.br` · `carla@labcentral.com.br` | admin/manager/attendant | 100/30/15% |
| `operador@crmlab.com.br` | platform_operator | 0% |

**O que mais entra:**

- **82 exames** reais de análises clínicas em pt-BR (Hematologia, Coagulação,
  Bioquímica, Hormônios, Imunologia, Sorologia, Marcadores tumorais, Vitaminas,
  Uroanálise, Parasitologia, Microbiologia) com nome, código, descrição,
  preparo, prazo e os dois preços — `price_insurance < price_private` sempre.
- **Canais internos `#geral` e `#aprovacoes`** por laboratório (onboarding,
  WORKFLOWS.md §7), com posts reais — incluindo o pedido de aprovação de
  desconto com a proposta anexada (`attached_proposal_id`).
- **114 conversas / 481 mensagens** em português, misturando os 3
  `sender_type` (`patient`, `agent`, `system`), com conversas **não atribuídas**
  (fila do chip) e `unread_count > 0`. `created_at` espalhado por ~12 semanas.
- **44 propostas** nos **6 estágios** (Pipeline sem coluna vazia), com itens do
  catálogo e `total_price` sempre vindo de `calculateTotal()` de
  `@crm-lab/shared` — nunca digitado (regra §1).
- **`proposal_status_history`** coerente: começa em `novo_contato`, só contém
  transições de `ALLOWED_TRANSITIONS` e termina no estágio atual da proposta.
  Um caminho ilegal derruba o seed na hora.
- Uma proposta com `approval_status = 'pending'` e **25% de desconto** criada
  por atendente de alçada 15%, mais uma `rejected`.
- `perdido` com `reason_lost` cobrindo os **5 motivos**; `ganho` com `closed_at`
  distribuído nas últimas semanas (série temporal da curva de receita).
- **Audit logs** de `create_proposal`, `update_proposal_status`,
  `approve_discount` e `reject_discount`.
- **Funil coerente** (BUSINESS_RULES.md §6): conversas > propostas > ganhos,
  taxa de ganho ~18% das propostas (o alarme da regra é >50%).

### Dataset E2E (`npm run seed:e2e`)

Fixo e determinístico: IDs, e-mails, senhas, preços e totais são constantes
exportadas de **`backend/src/db/seeds/e2e-fixtures.ts`**, módulo sem dependência
de runtime (só `import type`) para que o Playwright importe direto em vez de
repetir strings soltas: `E2E_TENANTS`, `E2E_USERS`, `E2E_PASSWORD`, `E2E_EXAMS`,
`E2E_EXAMS_BETA`, `E2E_CONVERSATIONS`, `E2E_PROPOSALS`, `E2E_CHANNELS`,
`E2E_APPROVAL_POST`.

Cobre os 7 cenários de `docs/guides/TESTING.md`: login · atendimento · orçamento
· aprovação de 25% · pipeline · personalização · isolamento (tenants `e2e-alfa`
e `e2e-beta`, com catálogos e conversas sem nenhum ID em comum).

### Testes (`backend/tests/seeds/`)

`seed-dev.spec.ts` e `seed-e2e.spec.ts` (26 testes) verificam: roda em banco
limpo; roda duas vezes sem duplicar; todo `total_price` bate com
`calculateTotal()`; todo `perdido` tem `reason_lost` válido e nenhum outro
estágio tem; todo histórico só usa transições de `ALLOWED_TRANSITIONS`; toda
proposta terminal tem `closed_at` e nenhuma não-terminal tem; proporções do
funil plausíveis; os dois tenants existem e nenhuma linha de um referencia o
outro (varredura de todas as FKs cross-tenant); e o dataset e2e é determinístico
(mesmos IDs em duas execuções).

---

## Próximas Leituras

- `docs/database/QUERIES.md` - Queries otimizadas
- `docs/database/RELATIONSHIPS.md` - Relacionamentos detalhados
- `docs/backend/MODELS.md` - Modelos TypeORM/Sequelize

