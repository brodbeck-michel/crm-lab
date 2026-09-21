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
  patient_id UUID,               -- D-059 (migração 003): FK para patients(id)
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
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE SET NULL   -- migração 003
);

CREATE INDEX idx_conversations_tenant_id ON conversations(tenant_id);
CREATE INDEX idx_conversations_assigned_to ON conversations(assigned_to);
CREATE INDEX idx_conversations_created_at ON conversations(created_at);
CREATE INDEX idx_conversations_phone ON conversations(patient_phone);
CREATE INDEX idx_conversations_patient_id ON conversations(patient_id);  -- migração 003
```

**`patient_id` é NULLABLE de propósito (D-059).** As colunas `patient_name`, `patient_phone` e
`patient_email` **permanecem** e continuam sendo a origem de tudo que `/conversations` responde
— nenhum contrato de §2 de API_CONTRACTS.md muda nesta onda. Isso é o passo 1 da regra dos 3
passos de AGENTS.md (criar novo → migrar dados → remover antigo): a coluna nova é preenchida
por backfill na migração 003 e pelo `findOrCreateByPhone` daqui em diante; a remoção das
denormalizadas fica para uma onda futura, quando nenhum caminho de leitura depender delas.

Linha com `patient_id IS NULL` é legítima (conversa criada antes do backfill em uma réplica
antiga): a ficha do paciente simplesmente não a lista, e o próximo webhook daquele telefone a
religa.

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

**Coluna nova (migração `005_insurances_and_catalog.sql`, Onda 7):**

```sql
ALTER TABLE proposals
  ADD COLUMN insurance_id UUID NULL,
  ADD CONSTRAINT fk_proposals_insurance
    FOREIGN KEY (insurance_id) REFERENCES insurances(id);
```

`NULL` = particular (D-082). **Imutável após a criação** nesta onda — `PATCH` não permite
trocar `insuranceId` (trocar re-precificaria itens com snapshot, D-004; comportamento novo que
exigiria decisão própria, registrado como limitação em API_CONTRACTS.md §3).

**Coluna nova (migração `011_proposal_number.sql`):**

```sql
ALTER TABLE proposals ADD COLUMN proposal_number INTEGER NOT NULL;
CREATE UNIQUE INDEX idx_proposals_tenant_number ON proposals(tenant_id, proposal_number);
```

**Coluna nova (migração `017_proposal_requesting_doctor.sql`, CRMLAB-9):**

```sql
ALTER TABLE proposals ADD COLUMN requesting_doctor VARCHAR(255) NULL;
```

Texto livre com o nome do médico solicitante (indicação clínica) do exame/atendimento —
**opcional, sem cadastro/autocomplete de médicos** (decisão fechada com o usuário no card
CRMLAB-9). `NULL` = nenhum médico informado (proposta antiga ou campo deixado em branco); string
vazia é normalizada para `NULL` pelo `ProposalService.create` antes de gravar — mesma convenção
de "um número, uma origem" para ausência de valor (BUSINESS_RULES §10). **Imutável após a
criação**, igual a `insurance_id`: não há `PATCH` que altere este campo nesta onda — se um fluxo
de edição de proposta já criada precisar mudar o médico solicitante, isso é decisão nova,
registrada como limitação declarada. Exposto em `ProposalDetail.requestingDoctor`
(API_CONTRACTS.md §3); **não** entra em `Proposal` (listagem/pipeline) — não há campo para ele no
`ProposalCard` (PAGES.md §5), só no detalhe/modal.

Numeração sequencial **POR TENANT**, gerada no `ProposalRepository.insertProposal` (
`pg_advisory_xact_lock(hashtext(tenant_id))` + `MAX(proposal_number) + 1`, na MESMA transação
do `INSERT` — sem tabela de contador dedicada). Existe para rastreamento citável por
telefone/WhatsApp (`id` é UUID, não citável) — exposta em `Proposal.proposalNumber`
(API_CONTRACTS.md §3), formatada na UI como `#000123` (`formatProposalNumber`,
`@crm-lab/shared`).

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
  position INT NOT NULL DEFAULT 0,  -- D-071 (migração 003): ordem em que o atendente montou
  
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
CREATE INDEX idx_proposal_items_proposal_position                    -- migração 003
  ON proposal_items(proposal_id, "position");
```

**`position` (D-071)** fecha o pedido do Agent-API-Proposals em STATUS.md. A ordem dos itens é
a que o atendente montou. Até a Onda 6 ela era mantida deslocando `created_at` em 1
microssegundo por item, porque o desempate por `id` (UUID aleatório) embaralhava a lista; esse
truque **foi removido** junto com a coluna — uma coluna de tempo servindo de coluna de ordem
sobrevive a qualquer reprocessamento que normalize timestamps. Com a coluna:

- o `INSERT` grava `position` = índice do item no array do request (base 0);
- toda leitura de itens ordena por **`position ASC, created_at ASC`** (o segundo critério cobre
  as linhas antigas, todas com `position = 0`);
- o `DEFAULT 0` torna a migração compatível com o dado existente — nenhum backfill seria
  *obrigatório*. A 003 mesmo assim preenche `position` a partir da ordem atual
  (`ROW_NUMBER() OVER (PARTITION BY proposal_id ORDER BY created_at ASC, id ASC) - 1`), para que
  uma proposta já existente não dependa do segundo critério para não embaralhar. O desempate por
  `id` torna o resultado estável quando dois itens compartilham o mesmo `created_at`.

**Coluna nova (migração `005_insurances_and_catalog.sql`, Onda 7):**

```sql
ALTER TABLE proposal_items
  ADD COLUMN price_source VARCHAR(20) NOT NULL DEFAULT 'private',
  ADD CONSTRAINT proposal_items_price_source_check CHECK (price_source IN ('insurance', 'private'));
```

Snapshot: com que origem o `unit_price` do item foi resolvido no momento da criação (D-004 —
mesma disciplina de `exam_name`/`unit_price`). `DEFAULT 'private'` cobre o dado existente (todas
as propostas anteriores à Onda 7 eram particulares por definição, já que `insurance_id` não
existia).

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

**Colunas novas (migração `005_insurances_and_catalog.sql`, Onda 7 — D-081):**

```sql
ALTER TABLE exam_catalog
  ADD COLUMN tuss_code VARCHAR(10),                       -- Código TUSS (tabela 22), 8 dígitos
  ADD COLUMN amb_code VARCHAR(20),                        -- Código AMB legado (de-para do faturamento)
  ADD COLUMN material VARCHAR(255),                       -- Ex.: "Sangue — tubo tampa roxa (EDTA)"
  ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'manual', -- CHECK: manual | lis
  ADD CONSTRAINT exam_catalog_source_check CHECK (source IN ('manual', 'lis'));
```

`tuss_code` e `amb_code` são `NULL` quando o código não foi confirmado pela pesquisa do seed —
**nunca inventados** (D-081). `source` só existe e é exibida nesta onda; a sincronização LIS que
decide quem vence numa edição concorrente é de onda futura, pós-resposta do Bitlab.
`price_insurance` (coluna única atual) **permanece** — passo 1 da regra dos 3 passos de
AGENTS.md: deixa de ser exibida/editável na UI (o preço por convênio passa a viver em
`exam_prices`, §19), e a remoção (passo 3) é pendência registrada com dono em `docs/STATUS.md`
para onda futura. Nenhum contrato de leitura existente quebra.

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
  key VARCHAR(100) NOT NULL,                   -- 'geral', 'aprovacoes' ou 'dm:{menorId}:{maiorId}'
  name VARCHAR(255) NOT NULL,                  -- '#geral'; em DM é valor interno (D-101)
  kind VARCHAR(20) NOT NULL DEFAULT 'channel', -- channel | dm
  dm_user_a_id UUID,                           -- só em DM; dm_user_a_id < dm_user_b_id
  dm_user_b_id UUID,                           -- migração 010 (D-101)
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (dm_user_a_id) REFERENCES users(id),
  FOREIGN KEY (dm_user_b_id) REFERENCES users(id),
  UNIQUE (tenant_id, key),
  CHECK (kind IN ('channel', 'dm')),
  CHECK (
    (kind = 'dm' AND dm_user_a_id IS NOT NULL AND dm_user_b_id IS NOT NULL
      AND dm_user_a_id < dm_user_b_id)
    OR
    (kind = 'channel' AND dm_user_a_id IS NULL AND dm_user_b_id IS NULL)
  )
);

CREATE INDEX idx_internal_channels_tenant_id ON internal_channels(tenant_id);
CREATE INDEX idx_internal_channels_dm_a ON internal_channels(dm_user_a_id);
CREATE INDEX idx_internal_channels_dm_b ON internal_channels(dm_user_b_id);
```

`UNIQUE (tenant_id, key)` é o que permite ao `createSystemPost(tenantId, channelKey, ...)`
resolver o canal pela chave sem ambiguidade — e também é o que torna
`POST /internal-chat/dms` idempotente: a chave canônica `dm:{menorId}:{maiorId}` (D-101)
garante um único canal por par de usuários, sem depender de checar `dm_user_a_id`/
`dm_user_b_id` antes de inserir.

`dm_user_a_id`/`dm_user_b_id` (migração `010_internal_chat_dm.sql`) existem para dois usos
que a `key` sozinha não resolve bem: **(1)** filtrar quais DMs um usuário pode ver/acessar
— `WHERE ch.kind = 'channel' OR $userId IN (dm_user_a_id, dm_user_b_id)`, usado por
`listChannels` e `findChannelById` (D-101: um não-participante recebe `NOT_FOUND`, nunca
enxerga a DM); **(2)** resolver o nome a exibir (`otherUserName`) sem parsear a `key`. O
`CHECK dm_user_a_id < dm_user_b_id` é o par ordenado canônico — evita duas linhas para o
mesmo par com a ordem trocada.

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
  absolute_expires_at TIMESTAMPTZ NOT NULL, -- teto da FAMÍLIA (CRMLAB-35, D-154)
  revoked_reason TEXT,                  -- 'rotated' | 'security' | NULL (CRMLAB-35, D-154)
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_tenant_id ON refresh_tokens(tenant_id);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
CREATE INDEX idx_refresh_tokens_absolute_expires_at ON refresh_tokens(absolute_expires_at);
```

Token válido = `revoked_at IS NULL AND expires_at > NOW() AND absolute_expires_at > NOW()`.

`absolute_expires_at` (CRMLAB-35, D-154): teto de 30 dias da FAMÍLIA (não do token
individual) — gravado no login e CARREGADO adiante em cada rotação, nunca reiniciado. Vencido
esse teto, o próximo refresh recusa mesmo com o token em si ainda dentro dos 7 dias rotativos.

É a única coluna de data desta tabela em `TIMESTAMPTZ`, e de propósito: é a única que faz
*round-trip* (lida do banco e regravada a cada rotação). Em `TIMESTAMP` naive o driver devolve
`Date` interpretando o valor como hora **local** enquanto a escrita manda UTC — o teto andava
para frente o equivalente ao fuso a cada rotação, e uma sessão ativa empurraria o próprio teto
para sempre. **Dívida conhecida:** `expires_at` e `revoked_at` têm o mesmo desvio na comparação
(3 h em UTC-3), sem efeito prático numa janela de 7 dias porque nunca são regravadas a partir
do que foi lido.

`revoked_reason` (CRMLAB-35, D-154): `'rotated'` = token consumido numa rotação normal —
reaparecer depois disso é sinal de roubo e derruba a família (D-015). `'security'` = derrubado
em massa por troca de senha ou desativação de usuário — reaparecer é o outro dispositivo
descobrindo que caiu, não ataque, e recusa só aquele token. `NULL` em linhas anteriores à
migração 022, lido como `'rotated'`.

Limpeza periódica (D-155, `main.ts`) apaga linhas com `expires_at`/`revoked_at` há mais de 7
dias — best-effort, não crítico.

---

### 14. `patients` (migração 003 — D-059)
Entidade própria do paciente. Antes da Onda 6, nome/telefone/e-mail viviam denormalizados em
`conversations`; a ficha `/patients/:id` (PAGES.md §3) exige cadastro editável, e um cadastro
que mora em N conversas não tem onde ser editado uma vez só.

```sql
CREATE TABLE patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  phone VARCHAR(20) NOT NULL,             -- identidade do paciente no tenant
  name VARCHAR(255),
  email VARCHAR(255),
  birth_date DATE,
  document VARCHAR(14),                   -- CPF, só dígitos
  notes TEXT,                             -- interno (BUSINESS_RULES §7)
  tags JSONB NOT NULL DEFAULT '[]',
  custom_fields JSONB NOT NULL DEFAULT '{}',
  anonymized_at TIMESTAMP,                -- LGPD (D-063). NOT NULL = cadastro apagado
  inactivated_at TIMESTAMP,               -- D-133. NOT NULL = paciente inativo
  inactivation_reason TEXT,               -- so existe enquanto inactivated_at NOT NULL
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, phone)
);

CREATE INDEX idx_patients_tenant_id ON patients(tenant_id);
CREATE INDEX idx_patients_document ON patients(tenant_id, document);
CREATE INDEX idx_patients_name
  ON patients USING GIN (to_tsvector('portuguese', COALESCE(name, '')));

CREATE TRIGGER trg_patients_updated_at
  BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

- **`UNIQUE (tenant_id, phone)`** é o que faz o webhook deduplicar: `findOrCreateByPhone`
  resolve o paciente pelo telefone dentro do tenant. Dois laboratórios podem ter o mesmo
  telefone — são pacientes distintos, e a unicidade é por tenant, nunca global.
- **Não há `DELETE`.** Propostas históricas apontam para conversas que apontam para o paciente;
  apagar a linha quebraria o histórico. O caminho LGPD é `anonymized_at` (D-063).
- `phone` continua `NOT NULL` depois da anonimização: o valor é substituído por
  `'anon-' || substring(id::text, 1, 8)`, que preserva `NOT NULL` **e** a unicidade.
- `document` é gravado só com dígitos (o CPF formatado é assunto do frontend). O índice
  `(tenant_id, document)` serve a busca por documento; não é `UNIQUE` — cadastro sem CPF é o
  caso normal, e dois cadastros do mesmo CPF em telefones diferentes acontecem na prática.
- **`inactivated_at`/`inactivation_reason` (migração 018 — D-133, CRMLAB-11).** Mesmo desenho de
  `anonymized_at`: sem tabela de histórico, sem `DELETE`. `inactivated_at NOT NULL` esconde o
  paciente de `GET /patients` por padrão (checkbox "Mostrar inativos" pede
  `?includeInactive=true`); os dados (conversas, propostas) continuam intactos. Reativar zera os
  dois campos — a justificativa da reativação vai só para `audit_logs`
  (`inactivate_patient`/`reactivate_patient`), nunca para a linha.
- O índice GIN usa **exatamente** a mesma expressão da busca por nome
  (`to_tsvector('portuguese', COALESCE(name, ''))`); expressão diferente = índice não usado.

**Backfill (migração 003):** uma linha por `(tenant_id, patient_phone)` distinto de
`conversations`. `name` e `email` recebem o valor **não nulo mais recente** daquele telefone
(`ARRAY_AGG(... ORDER BY last_message_at DESC NULLS LAST, created_at DESC) FILTER (WHERE ... IS
NOT NULL)`), e os dois campos são escolhidos **independentemente**: uma conversa recente sem
e-mail não apaga o e-mail que a conversa anterior conhecia — o cadastro fica com o melhor de
cada campo, não com o retrato de uma única conversa. `created_at` do paciente é o `MIN` das
conversas daquele telefone. Em seguida, `UPDATE conversations SET patient_id = ...` casando por
`(tenant_id, patient_phone)`.

---

### 15. `tenant_channels` (migração 003 — D-064)
Conexão de canal por laboratório. Fecha o pedido do Agent-API-Conversations em STATUS.md
(D-024): enquanto esta tabela não existia, as credenciais vinham de env var e a identidade do
tenant, do slug na URL do webhook.

```sql
CREATE TABLE tenant_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  channel VARCHAR(50) NOT NULL,          -- whatsapp | sms | web | direct
  display_name VARCHAR(255),
  phone_number_id VARCHAR(255),          -- id público do número no provedor
  phone_number VARCHAR(30),
  api_token TEXT,                        -- SEGREDO: nunca sai do backend
  webhook_secret TEXT,                   -- SEGREDO: nunca sai do backend
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  connected_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, channel),
  CHECK (channel IN ('whatsapp', 'sms', 'web', 'direct'))
);

CREATE INDEX idx_tenant_channels_tenant_id ON tenant_channels(tenant_id);

CREATE TRIGGER trg_tenant_channels_updated_at
  BEFORE UPDATE ON tenant_channels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**`api_token` e `webhook_secret` não aparecem em nenhuma resposta de API** — nem mascarados no
banco, nem em log, nem em audit log (`newValues` grava `"api_token": "[REDACTED]"`). A API
devolve `apiTokenMasked` (`'••••••••' + últimos 4`) e `webhookSecretSet: boolean`. Ver
API_CONTRACTS.md §6. Repositório que fizer `SELECT *` nesta tabela e devolver a linha ao
controller é bug de segurança: o repositório projeta colunas explicitamente.

`UNIQUE (tenant_id, channel)` é o que permite ao `PATCH /settings/channels` fazer upsert pela
chave `channel` em vez de exigir o `id` na tela.

**Colunas novas (migração `005_insurances_and_catalog.sql`, Onda 7 — Bloco B):**

```sql
ALTER TABLE tenant_channels
  ADD COLUMN connection_mode VARCHAR(20) NOT NULL DEFAULT 'cloud_api',
  ADD CONSTRAINT tenant_channels_connection_mode_check CHECK (connection_mode IN ('cloud_api', 'qr')),
  ADD COLUMN accepted_terms_at TIMESTAMP NULL,
  ADD COLUMN accepted_terms_by UUID NULL,
  ADD CONSTRAINT fk_tenant_channels_accepted_terms_by
    FOREIGN KEY (accepted_terms_by) REFERENCES users(id) ON DELETE SET NULL;
```

`connection_mode` decide o driver de envio no `WhatsAppCredentialsResolver` (SERVICES.md §11/
§16): `cloud_api` é a API oficial da Meta (comportamento de hoje, default — linha ausente ou
coluna antiga também vale `cloud_api`); `qr` é o número próprio pareado via QR code no gateway
Evolution, sem API oficial. `accepted_terms_at`/`accepted_terms_by` registram o aceite do termo
de risco do QR (banimento, violação de ToS) — é dado do **canal**, não só do audit log: a UI
precisa saber, na abertura da tela, se o termo já foi aceito, sem depender de uma consulta a
`audit_logs`. Quando `apikey` é gravada para uma instância `qr`, ela usa o mesmo `api_token`
desta tabela, cifrada com a mesma infra da D-076 (`CHANNEL_SECRET_KEY`).

---

### 16. `tenant_settings` (migração 003 — D-065)
Configuração **operacional** do laboratório: modo de distribuição, mensagens automáticas e
horário de atendimento. 1:1 com `tenants`.

```sql
CREATE TABLE tenant_settings (
  tenant_id UUID PRIMARY KEY,
  distribution_mode VARCHAR(20) NOT NULL DEFAULT 'manual',  -- manual | round_robin
  greeting_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  greeting_message TEXT,
  offhours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  offhours_message TEXT,
  business_hours JSONB NOT NULL DEFAULT '{"timezone":"America/Sao_Paulo","days":{}}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CHECK (distribution_mode IN ('manual', 'round_robin'))
);

CREATE TRIGGER trg_tenant_settings_updated_at
  BEFORE UPDATE ON tenant_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**Por que tabela própria e não colunas em `tenants`:** `tenants` é a tabela raiz, escrita pelo
console da plataforma (identidade, plano, assinatura) e sob RLS por `id`, não por `tenant_id`.
Misturar configuração de operação do laboratório ali significaria o `PATCH` de uma tela de
admin de tenant escrevendo na mesma linha que o console de billing edita, e uma policy de RLS
com forma diferente das outras. `tenant_settings` tem `tenant_id` como PK **e** chave da policy
padrão — o mesmo formato das demais 15 tabelas.

`business_hours` é JSONB por ser configuração de exibição/decisão lida inteira, nunca filtrada
por parte. Shape (validado no service, tipado em `shared/types/settings.types.ts`):

```json
{ "timezone": "America/Sao_Paulo",
  "days": { "mon": { "start": "08:00", "end": "18:00" }, "sat": null } }
```

Dia ausente ou `null` = fechado. **Linha ausente = defaults** (`manual`, mensagens desligadas,
`America/Sao_Paulo`, sem dias): o `GET` responde os defaults sem gravar, e o primeiro `PATCH`
faz `INSERT ... ON CONFLICT (tenant_id) DO UPDATE`. O onboarding
(`POST /platform/tenants`) **não** precisa criar a linha.

---

### 17. `channel_reads` (migração 003 — D-068)
Estado de leitura de canal interno, por usuário. É o que faz `Channel.unreadCount` zerar
(pendência D5 da Onda 5; supera D-044, que servia `0` fixo por falta de tabela).

```sql
CREATE TABLE channel_reads (
  tenant_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  user_id UUID NOT NULL,
  last_read_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES internal_channels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_channel_reads_tenant_id ON channel_reads(tenant_id);
CREATE INDEX idx_channel_reads_user ON channel_reads(user_id);

CREATE TRIGGER trg_channel_reads_updated_at
  BEFORE UPDATE ON channel_reads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

- `tenant_id` é redundante com o canal, e obrigatório pelo mesmo motivo de `proposal_items`
  (D-002 + AGENTS.md Contrato 2): sem ele a policy precisaria de um `EXISTS` no canal.
- Ausência de linha = usuário nunca abriu o canal → `lastReadAt: null` e `unreadCount` conta
  todas as mensagens de terceiros.
- `POST /internal-chat/channels/:id/read` faz
  `INSERT ... ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = NOW()`.
  Idempotente por construção.
- A policy de `channel_reads` (migração 004) isola por `tenant_id` como as demais **e**, no
  `WITH CHECK`, exige que `channel_id` e `user_id` existam no tenant do contexto: as FKs são
  verificadas fora do RLS, então sem isso um `INSERT` feito no contexto de A poderia gravar a
  leitura do usuário de B — linha válida para o banco e atravessando a fronteira do produto.
- `unreadCount` do canal é **derivado**, nunca materializado (BUSINESS_RULES §5):

```sql
COUNT(*) FILTER (
  WHERE m.created_at > COALESCE(r.last_read_at, '-infinity'::timestamp)
    AND (m.sender_id IS DISTINCT FROM :userId)
)
```

Mensagem de sistema (`sender_id IS NULL`) **conta** — o pedido de aprovação em `#aprovacoes` é
justamente o que precisa aparecer como não lido.

---

### 18. `insurances` (migração 005 — Onda 7, D-081/D-082)
Convênio do laboratório. Fecha o pedido da integração Bitlab Fase 1 (Trilha A) de modelar
convênio como entidade, em vez de um único `price_insurance` em `exam_catalog`.

```sql
CREATE TABLE insurances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,            -- nome usual: "Unimed Tubarão"
  official_name VARCHAR(255),            -- razão social, opcional
  ans_code VARCHAR(20),                  -- registro ANS, opcional (SC Saúde não tem)
  type VARCHAR(30) NOT NULL,             -- CHECK: cooperativa|medicina_grupo|seguradora|autogestao|especial
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, name),
  CHECK (type IN ('cooperativa', 'medicina_grupo', 'seguradora', 'autogestao', 'especial'))
);

CREATE INDEX idx_insurances_tenant_id ON insurances(tenant_id);
CREATE INDEX idx_insurances_active ON insurances(is_active);

CREATE TRIGGER trg_insurances_updated_at
  BEFORE UPDATE ON insurances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**"Particular" NÃO é uma linha desta tabela** (D-082): particular é a ausência de convênio
(`proposals.insurance_id NULL`). Um convênio fantasma "Particular" exigiria espelhar
`price_private` em `exam_prices` — uma segunda origem para o mesmo número
(BUSINESS_RULES.md §5). Sem `DELETE`: desativação por `PATCH { isActive: false }`, mesmo padrão
do catálogo (D-004).

### 19. `exam_prices` (migração 005 — Onda 7)
Preço por (exame, convênio). É a tabela que o espelhamento do Bitlab (quando houver resposta
deles) vai escrever — a coluna `exam_catalog.source` (§7) decide quem vence numa edição
concorrente, de onda futura.

```sql
CREATE TABLE exam_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  exam_id UUID NOT NULL,
  insurance_id UUID NOT NULL,
  price NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (exam_id) REFERENCES exam_catalog(id) ON DELETE CASCADE,
  FOREIGN KEY (insurance_id) REFERENCES insurances(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, exam_id, insurance_id),
  CHECK (price >= 0)
);

CREATE INDEX idx_exam_prices_tenant_id ON exam_prices(tenant_id);
CREATE INDEX idx_exam_prices_exam_id ON exam_prices(exam_id);
CREATE INDEX idx_exam_prices_insurance_id ON exam_prices(insurance_id);

CREATE TRIGGER trg_exam_prices_updated_at
  BEFORE UPDATE ON exam_prices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

Linha ausente para um (exame, convênio) não é erro: `ExamCatalogService.list`/
`resolveActiveByIds` (SERVICES.md §5, com `insuranceId`) cai em `exam_catalog.price_private`,
marcando `priceSource: "private"` — o fallback nunca bloqueia o orçamento (decisão 4 do spec da
Onda 7). `PUT /exams/:id/prices` (API_CONTRACTS.md §4) faz upsert em lote com semântica de
estado completo: linha ausente do corpo do PUT é removida da tabela.

### 20. `exam_synonyms` (migração 005 — Onda 7)
Nomes alternativos do exame, para a busca de `GET /exams?search=` casar também por sinônimo.

```sql
CREATE TABLE exam_synonyms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  exam_id UUID NOT NULL,
  synonym VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (exam_id) REFERENCES exam_catalog(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, exam_id, synonym)
);

CREATE INDEX idx_exam_synonyms_tenant_id ON exam_synonyms(tenant_id);
CREATE INDEX idx_exam_synonyms_exam_id ON exam_synonyms(exam_id);
```

Sem trigger de `updated_at`: a linha inteira é regravada (delete + insert) a cada PATCH que
enviar `synonyms`, nunca atualizada em lugar — não há coluna para atualizar além da própria
string. Busca: `EXISTS (SELECT 1 FROM exam_synonyms s WHERE s.tenant_id = e.tenant_id AND
s.exam_id = e.id AND folded(s.synonym) LIKE ...)` como terceiro ramo do `OR` de
`exam.repository.ts`, mesma dobra de caixa/acento (`folded()` = `translate + lower`,
`unaccent` indisponível no PGlite) já usada para nome e código. Por ser comportamento do
endpoint, vale automaticamente para `/catalog`, `/budget/new` e qualquer consumidor futuro.

---

### 21. `conversation_pins` (migração 007 — Onda 8 §2.3)
Conversa fixada no topo da lista, **por atendente**. Fixar é ferramenta pessoal: uma
atendente fixando não entope o topo da lista das outras.

```sql
CREATE TABLE conversation_pins (
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, conversation_id)
);

CREATE INDEX conversation_pins_lookup ON conversation_pins (tenant_id, user_id);
```

**Por que tabela e não coluna:** `pinned_at` em `conversations` seria menor, mas seria
estado COMPARTILHADO — o que uma pessoa fixa apareceria fixado para todo mundo. É assim
que WhatsApp e Slack se comportam e a expectativa do usuário já está formada.

Sem `id` próprio: a chave natural `(user_id, conversation_id)` já é a identidade da linha,
e é ela que torna `POST /pin` idempotente (`ON CONFLICT DO NOTHING`). `tenant_id` existe
para o RLS — `user_id` sozinho bastaria para a consulta, mas a policy precisa da coluna.

---

### 22. `quick_replies` (migração 008 — Onda 8 §3.2)
Respostas rápidas ("macros") do laboratório — o texto que a atendente dispara digitando
`/atalho` no Composer.

```sql
CREATE TABLE quick_replies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shortcut   TEXT NOT NULL,          -- sem a barra: "horariocoleta"
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quick_replies_shortcut_format CHECK (shortcut ~ '^[a-z0-9-]{2,32}$'),
  UNIQUE (tenant_id, shortcut)
);
```

**O CHECK não é decoração.** `shortcut` é o que a pessoa digita depois da `/`: se aceitasse
maiúscula, acento ou espaço, `/Horário Coleta` viraria um atalho impossível de acertar no
teclado, e o filtro do menu nunca encontraria a macro. O banco recusa antes de a linha
existir; o service traduz a recusa em `VALIDATION_ERROR` com o campo `shortcut`.

`UNIQUE (tenant_id, shortcut)` — não global: dois laboratórios podem ter `/coleta` com
textos diferentes, e a unicidade só faz sentido dentro do tenant.

`created_by ON DELETE SET NULL`: a macro é do laboratório, não de quem a escreveu. Remover
a autora não pode apagar o texto que a equipe inteira usa todo dia.

Não há `is_active`: `DELETE /quick-replies/:id` apaga de verdade. Diferente de convênio e
exame, macro não é referenciada por proposta nem por histórico — o texto já foi copiado
para a mensagem no momento do envio. O audit log guarda o conteúdo apagado.

---

### 23. `message_media` (migração 009 — Onda 8 §4)
Mídia de mensagem (foto, PDF, áudio) — o arquivo em si fica em disco (`MEDIA_DIR`,
volume local, sem MinIO/S3 nesta onda); esta tabela guarda só o metadado.

```sql
CREATE TABLE message_media (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id  UUID REFERENCES messages(id) ON DELETE CASCADE,
  mime_type   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  byte_size   INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX message_media_tenant_lookup ON message_media (tenant_id);
```

**`message_id` é NULLABLE de propósito.** O arquivo é gravado em disco — com o nome
IGUAL ao `id` desta linha — antes de a mensagem existir, porque `messages.attachment_url`
precisa do id para ser montado (`/api/v1/media/<id>`). A ordem é: insere a linha (sem
`message_id`) → grava o arquivo → cria a mensagem com o `attachmentUrl` já resolvido →
`UPDATE message_media SET message_id = ...`.

**`file_name` nunca vira nome de arquivo em disco.** O arquivo é nomeado pelo `id`
(UUID gerado pelo Postgres); `file_name` é só o que a tela mostra. Aceitar o nome que o
usuário mandou no CAMINHO do disco é travessia de diretório pronta.

`GET /media/:id` nunca é servido como arquivo estático público (`express.static`
apontando para a pasta) — é exame e áudio de paciente, e UUID adivinhado sobre uma pasta
estática seria vazamento de dado de saúde sem passar por autenticação nem por RLS.

---

### 24. `attendants` (migração 012 — Onda 9, D-112)
Atendente do LIS. O `USUÁRIO` da planilha de orçamentos vira `attendant_id`; ligar a um
`users.id` (login no CRM) é **opcional e manual** — atendente do LIS não precisa ser usuário do
sistema. Fecha a modelagem do spec da fusão CRM Lab + FluxoLab §2.1.

```sql
CREATE TABLE attendants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  folded_name VARCHAR(255) GENERATED ALWAYS AS (
    lower(regexp_replace(trim(name), '\s+', ' ', 'g'))
  ) STORED,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  user_id UUID NULL,                     -- opcional: liga o atendente a um login do CRM
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, folded_name)
);

CREATE INDEX idx_attendants_tenant_id ON attendants(tenant_id);
CREATE INDEX idx_attendants_user_id ON attendants(user_id);

CREATE TRIGGER trg_attendants_updated_at
  BEFORE UPDATE ON attendants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

`folded_name` (**D-111**, mesma família de `GENERATED … STORED` de `lis_budgets` abaixo) é o que
faz `UNIQUE (tenant_id, folded_name)` deduplicar "Maria Souza", "maria souza" e "Maria  Souza"
(espaço duplo) como o mesmo atendente — nome de atendente na planilha do LIS não tem disciplina
de digitação (BUSINESS_RULES.md §11). Acento **não** é removido (ao contrário de
`exam.repository.folded()`, que usa `translate`): avaliar essa remoção é risco explícito do spec,
registrado para decisão futura, não implementado nesta onda.

`UNIQUE (tenant_id, user_id)` permite `NULL` múltiplos (comportamento padrão de `UNIQUE` do
Postgres com `NULL`): vários atendentes sem login não colidem entre si; um `user_id` já ligado a
outro atendente é rejeitado.

### 25. `lis_imports` (migração 012 — Onda 9, D-109)
Histórico **imutável** de importação de planilha do LIS (e de "Limpar base"). Sem `DELETE` na
API — é o log de auditoria da própria importação, não um dado de trabalho.

```sql
CREATE TABLE lis_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  kind VARCHAR(20) NOT NULL,             -- CHECK: import | purge
  file_name VARCHAR(255),                -- NULL em kind='purge'
  rows_in_file INT,
  rows_accepted INT,
  rows_rejected INT,
  proposals_won INT,                     -- preenchido só a partir da Onda 13 (D-118)
  status VARCHAR(20) NOT NULL DEFAULT 'processing', -- CHECK: processing | completed | failed
  error_message TEXT,
  created_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  finished_at TIMESTAMP NULL,

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (kind IN ('import', 'purge')),
  CHECK (status IN ('processing', 'completed', 'failed'))
);

CREATE INDEX idx_lis_imports_tenant_id ON lis_imports(tenant_id);
CREATE INDEX idx_lis_imports_tenant_created ON lis_imports(tenant_id, created_at DESC);
```

`GET /lis-imports/latest` (API_CONTRACTS.md §10) lê a linha mais recente por
`(tenant_id, created_at DESC)`; o índice composto existe para essa consulta, além da listagem
paginada. `proposals_won` fica em `0`/`NULL` até a Onda 13 ligar a conciliação (D-118) — a
coluna **nasce aqui** porque é o import quem sabe quantas propostas fechou naquela rodada, e
criar a coluna numa migração futura obrigaria a alterar uma tabela de histórico já escrita.

### 26. `lis_budgets` (migração 012 — Onda 9, D-110/D-111/D-114)
Uma linha por `UNIQUE (tenant_id, number)` — o orçamento do LIS, já deduplicado e consolidado
pelo `LisImportService` (BUSINESS_RULES.md §11: maior `total_value` vence). É a tabela que
`GET /lis-budgets*`, Resultados, Conferência e Busca Ativa leem.

```sql
CREATE TABLE lis_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  number VARCHAR(50) NOT NULL,           -- coluna ORCAMENTO da planilha (obrigatória)
  issued_on DATE,                        -- DATA_ORÇAMENTO (D-110: DATE, não TIMESTAMP)
  patient_name VARCHAR(255),             -- NM_PACIENTE — dado pessoal sem patient_id (§6 do spec)

  insurance_1 VARCHAR(255),              -- CONVENIO1
  value_1 NUMERIC(12,2),                 -- VL_TOTAL1
  insurance_2 VARCHAR(255),              -- CONVENIO2
  value_2 NUMERIC(12,2),                 -- VL_TOTAL2
  insurance_3 VARCHAR(255),              -- CONVENIO3
  value_3 NUMERIC(12,2),                 -- VL_TOTAL3

  principal_insurance_name VARCHAR(255) GENERATED ALWAYS AS (
    CASE
      WHEN insurance_1 IS NOT NULL AND COALESCE(value_1, 0) > 0 THEN insurance_1
      WHEN insurance_2 IS NOT NULL AND COALESCE(value_2, 0) > 0 THEN insurance_2
      WHEN insurance_3 IS NOT NULL AND COALESCE(value_3, 0) > 0 THEN insurance_3
      WHEN insurance_1 IS NOT NULL THEN insurance_1
      WHEN insurance_2 IS NOT NULL THEN insurance_2
      WHEN insurance_3 IS NOT NULL THEN insurance_3
      ELSE NULL
    END
  ) STORED,
  -- Valor do CONVÊNIO PRINCIPAL — mesma seleção de principal_insurance_name
  -- acima, nunca a soma dos três (value_2/value_3 são cotações ALTERNATIVAS
  -- do mesmo orçamento, não valores adicionais). Corrigido pela migração 014
  -- (D-124) — a versão original de 012 somava os três por engano.
  total_value NUMERIC(12,2) GENERATED ALWAYS AS (
    CASE
      WHEN insurance_1 IS NOT NULL AND COALESCE(value_1, 0) > 0 THEN value_1
      WHEN insurance_2 IS NOT NULL AND COALESCE(value_2, 0) > 0 THEN value_2
      WHEN insurance_3 IS NOT NULL AND COALESCE(value_3, 0) > 0 THEN value_3
      WHEN insurance_1 IS NOT NULL THEN COALESCE(value_1, 0)
      WHEN insurance_2 IS NOT NULL THEN COALESCE(value_2, 0)
      WHEN insurance_3 IS NOT NULL THEN COALESCE(value_3, 0)
      WHEN COALESCE(value_1, 0) > 0 THEN value_1
      WHEN COALESCE(value_2, 0) > 0 THEN value_2
      WHEN COALESCE(value_3, 0) > 0 THEN value_3
      ELSE 0
    END
  ) STORED,

  insurance_id UUID NULL,                -- convênio resolvido; NULL = particular (D-082/D-114)
  attendant_name VARCHAR(255),           -- USUÁRIO/USUARIO cru da planilha
  attendant_id UUID NULL,                -- atendente resolvido (§24)
  insurance_average NUMERIC(12,2),       -- MEDIA_CONVENIO

  requisition_number VARCHAR(50),        -- REQUISICAO (5 aliases na planilha)
  requisition_value NUMERIC(12,2),       -- VALOR_REQUISICAO
  paid_value NUMERIC(12,2),              -- Valor_Pago (3 aliases)
  paid_on DATE,                          -- DATA_PAGAMENTO (5 aliases; D-110: DATE)

  import_id UUID NOT NULL,               -- importação que gravou/atualizou esta linha por último
  proposal_id UUID NULL,                 -- conciliação (Onda 13, D-119) — nasce NULL nesta onda

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (insurance_id) REFERENCES insurances(id),
  FOREIGN KEY (attendant_id) REFERENCES attendants(id),
  FOREIGN KEY (import_id) REFERENCES lis_imports(id),
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, number)
);

CREATE INDEX idx_lis_budgets_tenant_issued ON lis_budgets(tenant_id, issued_on);
CREATE INDEX idx_lis_budgets_tenant_paid ON lis_budgets(tenant_id, paid_on) WHERE paid_value > 0;
CREATE INDEX idx_lis_budgets_tenant_requisition ON lis_budgets(tenant_id, requisition_number);
CREATE INDEX idx_lis_budgets_tenant_attendant ON lis_budgets(tenant_id, attendant_id);

CREATE TRIGGER trg_lis_budgets_updated_at
  BEFORE UPDATE ON lis_budgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

- **Datas são `DATE`, não `TIMESTAMP` (D-110):** o serial do Excel não carrega fuso, e todo
  agrupamento de KPI é por dia/mês — `TIMESTAMP` introduziria a mesma classe de bug de UTC-3 já
  corrigida em D-021/D-078 para dado que nunca teve hora.
- **`principal_insurance_name` e `total_value` são `GENERATED … STORED` (D-111):** convênio
  principal e valor total do orçamento são regra de negócio pura sobre `insurance_1..3`/
  `value_1..3` (BUSINESS_RULES.md §11) — calculá-los no INSERT/UPDATE do backend arriscaria uma
  segunda implementação divergente no dia em que outro caminho de escrita aparecer (seed,
  script de correção). **Risco registrado no spec (§6):** validar `GENERATED … STORED` no
  PGlite **na primeira hora** da Onda 9; se não for suportado, o fallback é calcular as duas
  colunas como colunas normais no `LisImportRepository`, num único ponto de escrita.
- **`insurance_id` resolvido por nome dobrado (D-114):** o nome de `principal_insurance_name` é
  casado contra `insurances.name` (mesma dobra de caixa/acento de `attendants.folded_name` e do
  catálogo); convênio inexistente é **criado** com `type='outro'`, `source='lis'`. `PARTICULAR`
  e variantes (`PARTICULAR`, `Particular`, `PARTICULAR ID...` — ver BUSINESS_RULES.md §11 para a
  lista) resolvem para `insurance_id NULL` — nunca criam um convênio "Particular" (D-082, que já
  valia para o domínio de propostas e se estende ao domínio do LIS). O nome bruto da planilha
  permanece em `insurance_1..3` mesmo depois de resolvido.
- **`attendant_name` vs `attendant_id`:** o mesmo padrão de `insurance_1..3` — a coluna crua
  nunca é apagada depois da resolução; é o que permite auditar uma resolução errada sem reabrir
  o arquivo original.
- **`patient_name` é dado pessoal sem `patient_id`** (risco registrado no spec §6, fora do fluxo
  LGPD de `patients`/D-063 desta onda): a política de retenção fica em aberto — ver
  `docs/DECISIONS.md` D-115 e a lista de riscos do spec da fusão.
- **`import_id NOT NULL`:** toda linha nasce de uma importação; não existe `lis_budgets` digitado
  à mão pela API (a Onda 9 não expõe `POST /lis-budgets`, só leitura — API_CONTRACTS.md §10).
- **`proposal_id`** nasce sempre `NULL` nesta onda — a coluna existe desde já porque `lis_budgets`
  é o lado "B" da conciliação, mas quem grava é o hook da Onda 13 (D-119); `ON DELETE SET NULL`
  para não travar a exclusão de uma proposta antiga.

### 27. `sales` (migração 012 — Onda 9)
Vendas avulsas (exames e check-ups) do laboratório, para o cálculo de comissão — herdado do
FluxoLab, sem tabela equivalente no CRM Lab hoje.

```sql
CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  attendant_id UUID NOT NULL,
  sold_on DATE NOT NULL,
  code VARCHAR(50),
  value NUMERIC(12,2) NOT NULL,
  exams TEXT,                            -- texto livre (nomes dos exames vendidos)
  kind VARCHAR(20) NOT NULL,             -- CHECK: exams | checkup
  created_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (attendant_id) REFERENCES attendants(id),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (value > 0),
  CHECK (kind IN ('exams', 'checkup'))
);

CREATE INDEX idx_sales_tenant_id ON sales(tenant_id);
CREATE INDEX idx_sales_tenant_sold_on ON sales(tenant_id, sold_on);
CREATE INDEX idx_sales_attendant_id ON sales(attendant_id);

CREATE TRIGGER trg_sales_updated_at
  BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

Comissão é `value × tenant_settings.commission_exams_pct` ou `commission_checkup_pct`, conforme
`kind` (BUSINESS_RULES.md §11) — **nunca** armazenada na linha da venda (D-002/BUSINESS_RULES
§5, um número não vive em dois lugares). `DELETE /sales/:id` apaga de verdade (mesma disciplina
de `quick_replies`, §22: venda lançada errada é corrigida apagando e relançando, não há
histórico dependente da linha). Escopo de leitura por papel: atendente só as próprias vendas
(`attendants.user_id = ctx.userId`); manager/admin veem todas — API_CONTRACTS.md §11.

### 28. `exam_packages` (migração 015 — CRMLAB-10, D-130)
Cadastro de pacotes de exames (combos), aba "Pacotes" dentro de Cadastro de Exames (`/catalog`).
Mesmo padrão de `exam_catalog` (§7): ativo/inativo em vez de `DELETE` (D-004).

```sql
CREATE TABLE exam_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, name),
  CHECK (discount_percent >= 0 AND discount_percent <= 100)
);

CREATE INDEX idx_exam_packages_tenant_id ON exam_packages(tenant_id);
CREATE INDEX idx_exam_packages_active ON exam_packages(is_active);

CREATE TRIGGER trg_exam_packages_updated_at
  BEFORE UPDATE ON exam_packages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

`discount_percent` é o desconto aplicado sobre a soma dos preços particulares CORRENTES dos
exames incluídos — nunca um preço próprio gravado (SERVICES.md/`calculatePackagePrivatePrice`,
`@crm-lab/shared`). `name` único por tenant, mesma regra de `exam_catalog.name`.

### 29. `exam_package_items` (migração 015 — CRMLAB-10)
Exames incluídos em cada pacote (M:N com `exam_catalog`).

```sql
CREATE TABLE exam_package_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  package_id UUID NOT NULL,
  exam_id UUID NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (package_id) REFERENCES exam_packages(id) ON DELETE CASCADE,
  FOREIGN KEY (exam_id) REFERENCES exam_catalog(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, package_id, exam_id)
);

CREATE INDEX idx_exam_package_items_tenant_id ON exam_package_items(tenant_id);
CREATE INDEX idx_exam_package_items_package_id ON exam_package_items(package_id);
CREATE INDEX idx_exam_package_items_exam_id ON exam_package_items(exam_id);
```

Sem coluna própria de preço: o preço de cada item é sempre o `price_private` CORRENTE de
`exam_catalog` no momento do cálculo (nunca copiado para esta tabela) — igual à razão de
`proposal_items` não guardar cópia do exame, exceto que aqui nem o preço no momento da criação é
congelado, porque o pacote é um CADASTRO (recalcula toda vez que é exibido), não uma proposta
fechada.

### 30. `exam_package_prices` (migração 015 — CRMLAB-10)
Preço do pacote por convênio — mesmo padrão de `exam_prices` (§19): fallback nunca bloqueia
(D-004); sem linha para o convênio, `effectivePrice` cai no `pricePrivate` calculado do pacote.

```sql
CREATE TABLE exam_package_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  package_id UUID NOT NULL,
  insurance_id UUID NOT NULL,
  price NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (package_id) REFERENCES exam_packages(id) ON DELETE CASCADE,
  FOREIGN KEY (insurance_id) REFERENCES insurances(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, package_id, insurance_id),
  CHECK (price >= 0)
);

CREATE INDEX idx_exam_package_prices_tenant_id ON exam_package_prices(tenant_id);
CREATE INDEX idx_exam_package_prices_package_id ON exam_package_prices(package_id);
CREATE INDEX idx_exam_package_prices_insurance_id ON exam_package_prices(insurance_id);

CREATE TRIGGER trg_exam_package_prices_updated_at
  BEFORE UPDATE ON exam_package_prices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

RLS das três tabelas em `016_rls_exam_packages.sql`, mesmo padrão de 005/006 e 012/013: arquivo
separado por consistência com o repositório, não por haver backfill (nenhuma linha é escrita por
esta migração).

**Sobre a tela de Novo Orçamento (`/budget/new`):** adicionar um pacote expande em N linhas no
resumo, uma por exame, usando o `pricePrivate` de cada `ExamPackageItem` (não o `effectivePrice`
do pacote, que é só o preço agregado mostrado no seletor) — ver PAGES.md §4. Isso é
propositalmente diferente de "somar o `effectivePrice` de cada exame para aquele convênio":
`GET /exam-packages` não expõe preço por-convênio por item (só do pacote como um todo), então a
expansão usa o preço particular corrente de cada exame incluído; o `effectivePrice` do pacote
(com sua própria tabela de convênio, `exam_package_prices`) serve para o atendente comparar o
valor esperado antes de adicionar. Não é o modo "Pacotes" da tela de Novo Orçamento resolvido em
CRMLAB-13 (bug de abas que não abrem nada) — é o consumo, pelo `CatalogSegments`, deste cadastro.

### Colunas novas em `tenant_settings`, `insurances` e `proposals` (migração 012 — Onda 9)

**`tenant_settings` ganha os percentuais de comissão (D-113):**

```sql
ALTER TABLE tenant_settings
  ADD COLUMN commission_budget_pct NUMERIC(5,2) NOT NULL DEFAULT 2.00,
  ADD COLUMN commission_exams_pct NUMERIC(5,2) NOT NULL DEFAULT 1.50,
  ADD COLUMN commission_checkup_pct NUMERIC(5,2) NOT NULL DEFAULT 1.50;
```

Os defaults são os percentuais validados em produção pelo FluxoLab (2% / 1,5% / 1,5% — antes
por-navegador em `localStorage`, agora por-tenant e por-linha). `commission_budget_pct` existe
desde já mas só ganha consumidor na Onda 13 (comissão sobre orçamento conciliado); as duas
outras já são usadas por `GET /sales/summary` nesta onda.

**`insurances` ganha `type = 'outro'` e `source` (D-114):**

```sql
ALTER TABLE insurances
  DROP CONSTRAINT insurances_type_check,
  ADD CONSTRAINT insurances_type_check
    CHECK (type IN ('cooperativa', 'medicina_grupo', 'seguradora', 'autogestao', 'especial', 'outro')),
  ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'manual',
  ADD CONSTRAINT insurances_source_check CHECK (source IN ('manual', 'lis'));
```

`type = 'outro'` é o valor gravado quando o convênio nasce da resolução automática de
`lis_budgets` (D-114); `source = 'lis'` marca a origem, espelhando `exam_catalog.source` (§7,
D-081). Convênio criado manualmente pela tela `/settings/insurances` continua `source = 'manual'`
— o `DEFAULT` cobre as linhas existentes sem backfill.

**`proposals` ganha as colunas de conciliação, criadas agora e usadas só na Onda 13 (D-118):**

```sql
ALTER TABLE proposals
  ADD COLUMN lis_budget_number VARCHAR(50),
  ADD COLUMN lis_requisition_number VARCHAR(50),
  ADD COLUMN lis_paid_value NUMERIC(12,2),
  ADD COLUMN lis_paid_on DATE,
  ADD COLUMN lis_reconciled_at TIMESTAMP;

CREATE UNIQUE INDEX idx_proposals_tenant_lis_budget_number
  ON proposals(tenant_id, lis_budget_number)
  WHERE lis_budget_number IS NOT NULL;
```

**As cinco colunas nascem NULL em toda proposta e nenhuma rota desta onda as escreve** — nem
`POST /proposals`, nem `PATCH /proposals/:id/*` ganham campo novo (API_CONTRACTS.md §3 só muda
na Onda 13, com `PATCH /proposals/:id/lis-reference`). Elas entram na `012` e não numa migração
futura porque, sem divisão de planos (D-108), não há razão para duas migrações e dois passes
pelo `ProposalService` — a coluna nasce junto com o resto do domínio LIS, e o comportamento
(gravar `lis_budget_number` a partir da tela, casar por número no import, avançar para `ganho`)
é construído inteiro na Onda 13 (D-119). O índice único parcial já impede duas propostas
disputarem o mesmo número de orçamento do LIS desde já, mesmo sem nenhum caminho de escrita
ainda ligado.

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
| `patients` | ✅ | migração `004_rls_onda6.sql` |
| `tenant_channels` | ✅ | idem — e o segredo nunca sai do repositório (projeção explícita) |
| `tenant_settings` | ✅ | idem — policy pela coluna `tenant_id`, que aqui também é a PK |
| `channel_reads` | ✅ | idem — via `tenant_id` próprio |
| `insurances` | ✅ | migração `006_rls_onda7.sql` |
| `exam_prices` | ✅ | idem |
| `exam_synonyms` | ✅ | idem |
| `attendants` | ✅ | migração `013_rls_lis_domain.sql` |
| `lis_imports` | ✅ | idem |
| `lis_budgets` | ✅ | idem |
| `sales` | ✅ | idem |
| `exam_packages` | ✅ | migração `016_rls_exam_packages.sql` |
| `exam_package_items` | ✅ | idem |
| `exam_package_prices` | ✅ | idem |

As **4 tabelas da migração 003** entram sob RLS na `004_rls_onda6.sql`, as **3 tabelas da
migração 005** entram na `006_rls_onda7.sql`, e as **4 tabelas novas da migração 012**
(`attendants`, `lis_imports`, `lis_budgets`, `sales`) entram na `013_rls_lis_domain.sql` — sempre
a policy padrão (mesma forma, mesmo `NULLIF(current_setting('app.tenant_id', true), '')::uuid`),
num par de migrações separado (lição da Onda 6: tabela sem policy não trava, vaza). A prova é a
mesma das outras: com contexto do tenant A, nenhuma linha de B em `SELECT`/`UPDATE`/`DELETE`, e
`INSERT` com `tenant_id` de B rejeitado pelo `WITH CHECK`. Tabela nova sem policy é **fail-open**
— o `GRANT` de `ALTER DEFAULT PRIVILEGES` já dá `SELECT` a `crm_app` no momento do `CREATE
TABLE`, então esquecer a policy é vazar entre laboratórios, não travar.

Verificado em PGlite (D-008) com 2 tenants, nas **13** tabelas da migração 001 (e,
em `onda6-schema.spec.ts`, nas 4 da migração 003; em `onda7-schema.spec.ts`, nas 3 da migração
005; em `rls-onda9.spec.ts`, nas 4 da migração 012): com `app.tenant_id` = tenant A, nenhuma
linha do tenant B aparece em `SELECT`/`UPDATE`/`DELETE`; `SELECT * FROM tenants` devolve
exatamente 1 linha (a de A); `INSERT` com `tenant_id` (ou `id`) de B é rejeitado pelo `WITH
CHECK`; sem `app.tenant_id` setado, todas as tabelas devolvem 0 linhas. O mesmo SQL roda em
Postgres 16 no docker.

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
├── 003_patients_and_channels.sql # patients, tenant_channels, tenant_settings, channel_reads,
│                                 # conversations.patient_id (+ backfill), proposal_items.position
├── 004_rls_onda6.sql             # policies das 4 tabelas da 003
├── 005_insurances_and_catalog.sql # insurances, exam_prices, exam_synonyms + colunas novas em
│                                  # exam_catalog, proposals, proposal_items, tenant_channels
├── 006_rls_onda7.sql             # policies das 3 tabelas da 005
├── 007_conversation_pins.sql     # conversation_pins + policy (Onda 8 §2.3)
├── 008_quick_replies.sql         # quick_replies + policy (Onda 8 §3.2)
├── 009_message_media.sql         # message_media + policy (Onda 8 §4)
├── 010_internal_chat_dm.sql      # internal_channels.dm_user_a_id/dm_user_b_id (D-101)
├── 011_proposal_number.sql       # proposals.proposal_number + índice único (tenant, number)
├── 012_lis_domain.sql            # attendants, lis_imports, lis_budgets, sales + colunas novas em
│                                  # tenant_settings, insurances, proposals (Onda 9, §24-27)
├── 013_rls_lis_domain.sql        # policies das 4 tabelas da 012 (Onda 9)
├── 015_exam_packages.sql         # exam_packages/_items/_prices (CRMLAB-10, §28-30)
├── 016_rls_exam_packages.sql     # policies das 3 tabelas da 015 (CRMLAB-10)
└── 017_proposal_requesting_doctor.sql  # proposals.requesting_doctor (CRMLAB-9)
```

A 007 e a 008 são arquivos ÚNICOS (tabela + policy), diferente dos pares 003/004 e 005/006: a
separação existe para o backfill poder rodar antes de a policy ligar, e nenhuma das duas
tem backfill — as tabelas nascem vazias. Um segundo arquivo aqui seria cerimônia sem função.

A 003/004 e a 005/006 seguem o mesmo padrão de arquivos separados: quando a migração tem
backfill de dado pré-existente, ele roda **antes** de existir policy nas tabelas novas (escreve
linhas de todos os tenants de uma vez, como o seed), e juntar as duas coisas no mesmo arquivo
obrigaria o backfill a rodar sob RLS já ligado. A 005 não tem backfill de dado do usuário (as 3
tabelas nascem vazias; o seed as popula depois), mas a separação por onda facilita rastrear qual
migração pertence a qual entrega.

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
`E2E_APPROVAL_POST` e, desde a Onda 6, `E2E_PATIENTS`, `E2E_TENANT_CHANNELS`,
`E2E_TENANT_SETTINGS`, `E2E_TENANT_WITHOUT_SETTINGS`, `E2E_CHANNEL_READS` e
`E2E_CHANNEL_UNREAD` (o `unreadCount` esperado por usuário/canal).

Cobre os 7 cenários de `docs/guides/TESTING.md`: login · atendimento · orçamento
· aprovação de 25% · pipeline · personalização · isolamento (tenants `e2e-alfa`
e `e2e-beta`, com catálogos e conversas sem nenhum ID em comum).

### Testes (`backend/tests/seeds/`)

`seed-dev.spec.ts` e `seed-e2e.spec.ts` (33 testes) verificam: roda em banco
limpo; roda duas vezes sem duplicar; todo `total_price` bate com
`calculateTotal()`; todo `perdido` tem `reason_lost` válido e nenhum outro
estágio tem; todo histórico só usa transições de `ALLOWED_TRANSITIONS`; toda
proposta terminal tem `closed_at` e nenhuma não-terminal tem; proporções do
funil plausíveis; os dois tenants existem e nenhuma linha de um referencia o
outro (varredura de todas as FKs cross-tenant); e o dataset e2e é determinístico
(mesmos IDs em duas execuções). Da Onda 6: um cadastro por `(tenant, telefone)` e
**nenhuma conversa sem `patient_id`**; um `tenant_channels` por laboratório; um
tenant **com** `tenant_settings` (`round_robin`) e outro **sem linha** (o caminho
"linha ausente = defaults" de D-065); e o `unreadCount` derivado batendo com
`E2E_CHANNEL_UNREAD` — com pelo menos um caso **diferente de zero**, que é o que
o E2E do badge precisa ter para provar que `POST .../read` zera.

`backend/tests/kernel/onda6-schema.spec.ts` prova as migrações 003/004: monta um
banco com **apenas 001 e 002** aplicadas, escreve dados como se fossem anteriores
à Onda 6 e só então aplica 003/004 pelo runner — é o único jeito de o backfill
não passar por vacuidade. Verifica 1 paciente por `(tenant, telefone)` distinto
(mesmo telefone em dois tenants = dois cadastros), nome/e-mail escolhidos
independentemente, conversa de telefone em branco sem cadastro, nenhuma conversa
com telefone conhecido em `patient_id NULL`, `proposal_items.position`
preservando a ordem atual, reaplicação do bloco de backfill sem nenhuma
diferença (inclusive `conversations.updated_at`), e RLS ligado com policy nas 4
tabelas novas — com 2 tenants e controle positivo em cada asserção.

---

## Próximas Leituras

- `docs/database/QUERIES.md` - Queries otimizadas
- `docs/database/RELATIONSHIPS.md` - Relacionamentos detalhados
- `docs/backend/MODELS.md` - Modelos TypeORM/Sequelize

