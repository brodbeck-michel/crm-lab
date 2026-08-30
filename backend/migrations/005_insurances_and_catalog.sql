-- =============================================================================
-- 005_insurances_and_catalog.sql
-- Onda 7, Bloco A — convenio como entidade, preco por (exame, convenio),
-- sinonimos de busca, TUSS/AMB/material no catalogo e as colunas de suporte em
-- proposals/proposal_items/tenant_channels (Bloco B).
--
-- Fonte: docs/database/SCHEMA.md §18-§20 (e as secoes 6, 7 e 15, que ganham
--        colunas novas) · docs/DECISIONS.md D-081/D-082.
--
-- Sem backfill de dados: toda coluna nova e NULLable ou tem DEFAULT compativel
-- com o dado existente (ver notas de cada bloco). O RLS das 3 tabelas novas
-- fica na 006_rls_onda7.sql, de proposito — mesmo padrao da 003/004: nenhuma
-- linha e escrita por esta migracao, entao a separacao aqui e so consistencia
-- com o padrao, nao necessidade.
--
-- Este arquivo e aplicado INTEIRO dentro de uma transacao pelo runner
-- (src/db/migrator.ts). Nao contem meta-comandos do psql.
-- =============================================================================

-- =============================================================================
-- 1. insurances — convenio do laboratorio (SCHEMA.md §18, D-081/D-082)
--
-- "Particular" NAO e uma linha desta tabela: e a AUSENCIA de convenio
-- (proposals.insurance_id NULL). Um convenio fantasma "Particular" exigiria
-- espelhar price_private em exam_prices — segunda origem para o mesmo numero.
-- Sem DELETE: desativacao por PATCH { isActive: false }, mesmo padrao do
-- catalogo (D-004).
-- =============================================================================
CREATE TABLE insurances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,            -- nome usual: "Unimed Tubarão"
  official_name VARCHAR(255),            -- razao social, opcional
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

-- =============================================================================
-- 2. exam_prices — preco por (exame, convenio) (SCHEMA.md §19)
--
-- Linha ausente para um (exame, convenio) nao e erro: o service cai em
-- exam_catalog.price_private, marcando priceSource: "private" — o fallback
-- nunca bloqueia o orcamento (decisao 4 do spec da Onda 7).
-- =============================================================================
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

-- =============================================================================
-- 3. exam_synonyms — nomes alternativos para a busca (SCHEMA.md §20)
--
-- Sem trigger de updated_at: a linha inteira e regravada (delete + insert) a
-- cada PATCH que enviar synonyms, nunca atualizada em lugar.
-- =============================================================================
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

-- =============================================================================
-- 4. exam_catalog — TUSS/AMB/material/source (SCHEMA.md §7, D-081)
--
-- tuss_code e amb_code sao NULL quando o codigo nao foi confirmado pela
-- pesquisa do seed — NUNCA inventados. price_insurance (coluna unica atual)
-- PERMANECE: passo 1 da regra dos 3 passos de AGENTS.md.
-- =============================================================================
ALTER TABLE exam_catalog
  ADD COLUMN tuss_code VARCHAR(10),
  ADD COLUMN amb_code VARCHAR(20),
  ADD COLUMN material VARCHAR(255),
  ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'manual',
  ADD CONSTRAINT exam_catalog_source_check CHECK (source IN ('manual', 'lis'));

-- =============================================================================
-- 5. proposals.insurance_id (SCHEMA.md §5)
--
-- NULL = particular (D-082). Imutavel apos a criacao nesta onda.
-- =============================================================================
ALTER TABLE proposals
  ADD COLUMN insurance_id UUID NULL,
  ADD CONSTRAINT fk_proposals_insurance
    FOREIGN KEY (insurance_id) REFERENCES insurances(id);

-- =============================================================================
-- 6. proposal_items.price_source (SCHEMA.md §6)
--
-- Snapshot: com que origem o unit_price do item foi resolvido no momento da
-- criacao (D-004). DEFAULT 'private' cobre o dado existente (toda proposta
-- anterior a Onda 7 era particular por definicao, ja que insurance_id nao
-- existia).
-- =============================================================================
ALTER TABLE proposal_items
  ADD COLUMN price_source VARCHAR(20) NOT NULL DEFAULT 'private',
  ADD CONSTRAINT proposal_items_price_source_check CHECK (price_source IN ('insurance', 'private'));

-- =============================================================================
-- 7. tenant_channels — modo de conexao e aceite do termo (SCHEMA.md §15,
--    Bloco B)
--
-- connection_mode decide o driver de envio no WhatsAppCredentialsResolver;
-- 'cloud_api' e o default (comportamento de hoje, API oficial da Meta). O
-- aceite do termo de risco do QR e dado do CANAL, nao so do audit log.
-- =============================================================================
ALTER TABLE tenant_channels
  ADD COLUMN connection_mode VARCHAR(20) NOT NULL DEFAULT 'cloud_api',
  ADD CONSTRAINT tenant_channels_connection_mode_check CHECK (connection_mode IN ('cloud_api', 'qr')),
  ADD COLUMN accepted_terms_at TIMESTAMP NULL,
  ADD COLUMN accepted_terms_by UUID NULL,
  ADD CONSTRAINT fk_tenant_channels_accepted_terms_by
    FOREIGN KEY (accepted_terms_by) REFERENCES users(id) ON DELETE SET NULL;
