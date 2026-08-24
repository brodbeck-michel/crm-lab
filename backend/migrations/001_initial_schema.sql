-- =============================================================================
-- 001_initial_schema.sql
-- CRM SaaS para Laboratorios — schema inicial completo
--
-- Fonte: docs/database/SCHEMA.md
-- Correcoes aplicadas conforme docs/DECISIONS.md D-012:
--   (a) `ON SET NULL` (sintaxe invalida) -> `ON DELETE SET NULL`
--   (b) FK circular tenants.theme_id -> themes.id removida (e a coluna theme_id
--       junto): themes.tenant_id ja e UNIQUE e modela o 1:1
--   (c) tabela proposal_status_history acrescentada (origem do campo `history`
--       de GET /proposals/:id)
-- Alem disso (D-002 / AGENTS.md "tenant_id e obrigatorio em toda tabela de
-- dados de laboratorio"): proposal_items ganha tenant_id proprio, para que a
-- policy de RLS seja direta e nao dependa de subquery.
--
-- Este arquivo e aplicado inteiro dentro de uma transacao pelo runner.
-- Nao contem meta-comandos do psql nem CREATE DATABASE.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Funcao de trigger: mantem updated_at sempre atual
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 1. tenants — cada laboratorio e um tenant
-- =============================================================================
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  logo_url VARCHAR(500),
  -- theme_id removido (D-012b): o 1:1 vive em themes.tenant_id UNIQUE
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

CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 2. users — usuarios dentro de um tenant
-- =============================================================================
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL, -- attendant, manager, admin, platform_operator
  discount_limit_percent INT DEFAULT 15,
  is_active BOOLEAN DEFAULT TRUE,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, email),
  CHECK (role IN ('attendant', 'manager', 'admin', 'platform_operator'))
);

CREATE INDEX idx_users_tenant_id ON users(tenant_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_active ON users(is_active);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 3. conversations — chats com pacientes
-- =============================================================================
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  patient_phone VARCHAR(20) NOT NULL,
  patient_name VARCHAR(255),
  patient_email VARCHAR(255),
  assigned_to UUID, -- User ID
  channel VARCHAR(50), -- whatsapp, sms, web, direct
  status VARCHAR(50) DEFAULT 'active', -- active, archived, closed
  last_message_at TIMESTAMP,
  unread_count INT DEFAULT 0,
  tags JSONB DEFAULT '[]',
  custom_fields JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL -- D-012a
);

CREATE INDEX idx_conversations_tenant_id ON conversations(tenant_id);
CREATE INDEX idx_conversations_assigned_to ON conversations(assigned_to);
CREATE INDEX idx_conversations_created_at ON conversations(created_at);
CREATE INDEX idx_conversations_phone ON conversations(patient_phone);

CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 4. messages — mensagens de uma conversa
-- =============================================================================
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  sender_type VARCHAR(50) NOT NULL, -- patient, agent, system
  sender_id UUID, -- User ID (nullable para patient/system)
  content TEXT NOT NULL,
  message_type VARCHAR(50) DEFAULT 'text', -- text, image, audio, pdf...
  attachment_url VARCHAR(500),
  status VARCHAR(50) DEFAULT 'sent', -- sent, delivered, read, failed
  external_message_id VARCHAR(255),
  read_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL -- D-012a
);

CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_status ON messages(status);
CREATE INDEX idx_messages_tenant_id ON messages(tenant_id);

-- =============================================================================
-- 5. exam_catalog — catalogo de exames por laboratorio
-- (criado antes de proposal_items, que o referencia)
-- =============================================================================
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
  UNIQUE (tenant_id, code)
);

CREATE INDEX idx_exam_catalog_tenant_id ON exam_catalog(tenant_id);
CREATE INDEX idx_exam_catalog_active ON exam_catalog(is_active);

CREATE TRIGGER trg_exam_catalog_updated_at
  BEFORE UPDATE ON exam_catalog
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 6. proposals — orcamentos / propostas
-- total_price permanece NOT NULL: e cache calculado pelo backend (D-003)
-- =============================================================================
CREATE TABLE proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  created_by UUID NOT NULL, -- User ID
  status VARCHAR(50) NOT NULL DEFAULT 'novo_contato',
  -- novo_contato, orcamento_enviado, follow_up, negociacao, ganho, perdido

  discount_percent NUMERIC(5,2) DEFAULT 0,
  total_price NUMERIC(12,2) NOT NULL,
  reason_lost VARCHAR(255),

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
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL, -- D-012a
  CHECK (status IN ('novo_contato', 'orcamento_enviado', 'follow_up', 'negociacao', 'ganho', 'perdido')),
  CHECK (discount_percent >= 0 AND discount_percent <= 100)
);

CREATE INDEX idx_proposals_tenant_id ON proposals(tenant_id);
CREATE INDEX idx_proposals_conversation_id ON proposals(conversation_id);
CREATE INDEX idx_proposals_status ON proposals(status);
CREATE INDEX idx_proposals_created_at ON proposals(created_at);

CREATE TRIGGER trg_proposals_updated_at
  BEFORE UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 7. proposal_items — exames selecionados (snapshot: D-004)
-- tenant_id proprio acrescentado (D-002 / AGENTS.md contrato 2)
-- =============================================================================
CREATE TABLE proposal_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  proposal_id UUID NOT NULL,
  exam_id UUID NOT NULL,
  quantity INT DEFAULT 1,
  unit_price NUMERIC(12,2) NOT NULL,

  -- Snapshot do nome do exame (para historico)
  exam_name VARCHAR(255) NOT NULL,

  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE,
  FOREIGN KEY (exam_id) REFERENCES exam_catalog(id),
  CHECK (quantity > 0)
);

CREATE INDEX idx_proposal_items_proposal_id ON proposal_items(proposal_id);
CREATE INDEX idx_proposal_items_tenant_id ON proposal_items(tenant_id);

-- =============================================================================
-- 8. proposal_status_history — origem do campo `history` de GET /proposals/:id
-- (D-012c)
-- =============================================================================
CREATE TABLE proposal_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  proposal_id UUID NOT NULL,
  status VARCHAR(50) NOT NULL,
  changed_by UUID,
  changed_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (status IN ('novo_contato', 'orcamento_enviado', 'follow_up', 'negociacao', 'ganho', 'perdido'))
);

CREATE INDEX idx_proposal_status_history_proposal ON proposal_status_history(proposal_id, changed_at);
CREATE INDEX idx_proposal_status_history_tenant_id ON proposal_status_history(tenant_id);

-- =============================================================================
-- 9. themes — personalizacao visual por tenant (1:1)
-- =============================================================================
CREATE TABLE themes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  accent VARCHAR(7) NOT NULL,   -- hex color
  accent_2 VARCHAR(7) NOT NULL,
  bg VARCHAR(7) NOT NULL,
  surface VARCHAR(7) NOT NULL,
  text VARCHAR(7) NOT NULL,
  font_id VARCHAR(50) DEFAULT 'figtree',
  radius_id VARCHAR(50) DEFAULT 'md', -- sm, md, lg
  brand_name VARCHAR(255),
  logo_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX idx_themes_tenant_id ON themes(tenant_id);

CREATE TRIGGER trg_themes_updated_at
  BEFORE UPDATE ON themes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 10. audit_logs — auditoria multitenant
-- =============================================================================
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  old_values JSONB,
  new_values JSONB,
  ip_address VARCHAR(50),
  user_agent VARCHAR(500),
  timestamp TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL -- D-012a
);

CREATE INDEX idx_audit_logs_tenant_id ON audit_logs(tenant_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp);

-- =============================================================================
-- 11. internal_channels — chat interno do laboratorio (SERVICES.md §7)
-- Canais padrao criados no onboarding: #geral, #aprovacoes
-- =============================================================================
CREATE TABLE internal_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  key VARCHAR(100) NOT NULL,       -- 'geral', 'aprovacoes', ou chave da DM
  name VARCHAR(255) NOT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'channel', -- channel | dm
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, key),
  CHECK (kind IN ('channel', 'dm'))
);

CREATE INDEX idx_internal_channels_tenant_id ON internal_channels(tenant_id);

-- =============================================================================
-- 12. internal_messages — mensagens dos canais internos
-- =============================================================================
CREATE TABLE internal_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  sender_id UUID,                       -- NULL quando is_system = TRUE
  content TEXT NOT NULL,
  attached_proposal_id UUID,            -- renderiza como cartao no frontend
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES internal_channels(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (attached_proposal_id) REFERENCES proposals(id) ON DELETE SET NULL
);

CREATE INDEX idx_internal_messages_channel_created ON internal_messages(channel_id, created_at DESC);
CREATE INDEX idx_internal_messages_tenant_id ON internal_messages(tenant_id);

-- =============================================================================
-- 13. refresh_tokens — refresh JWT guardado hasheado (AuthService)
-- =============================================================================
CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_tenant_id ON refresh_tokens(tenant_id);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);

-- =============================================================================
-- Indices para performance (secao "Indices para Performance" do SCHEMA.md)
-- =============================================================================

-- Multitenant queries
CREATE INDEX idx_conversations_tenant_created ON conversations(tenant_id, created_at DESC);
CREATE INDEX idx_proposals_tenant_status ON proposals(tenant_id, status);

-- User queries
CREATE INDEX idx_users_tenant_email ON users(tenant_id, email);

-- Sorting / Filtering
CREATE INDEX idx_messages_conversation_created ON messages(conversation_id, created_at DESC);

-- Search (busca por nome de paciente)
CREATE INDEX idx_conversations_patient_name
  ON conversations USING GIN (to_tsvector('portuguese', COALESCE(patient_name, '')));
