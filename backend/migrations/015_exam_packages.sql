-- =============================================================================
-- 015_exam_packages.sql
-- CRMLAB-10 — Cadastro de pacotes de exames (combos), nova aba dentro do
-- Cadastro de Exames (`/catalog`, D-129). NÃO é o modo "Pacotes" (quebrado,
-- bug CRMLAB-13, backlog separado) da tela de Novo Orçamento — telas e
-- escopos diferentes.
--
-- Fonte: docs/api/API_CONTRACTS.md §4b · docs/database/SCHEMA.md §28-30 ·
--        docs/DECISIONS.md D-130.
--
-- exam_packages        — cadastro do pacote (nome, desconto%, ativo/inativo,
--                         mesmo padrão de exam_catalog: D-004, sem DELETE).
-- exam_package_items    — exames incluídos no pacote (M:N com exam_catalog).
-- exam_package_prices   — preço por (pacote, convênio), mesmo padrão de
--                         exam_prices (SCHEMA.md §19): fallback nunca
--                         bloqueia (D-004).
--
-- O preço PARTICULAR do pacote nunca é coluna: é sempre a soma dos preços
-- CORRENTES dos exames incluídos menos discount_percent, calculada no
-- service (ExamPackageService/calculatePackagePrivatePrice), nunca digitada.
--
-- RLS das 3 tabelas na 016_rls_exam_packages.sql, mesmo padrão 005/006 e
-- 012/013: nenhuma linha é escrita por esta migração, então a separação é
-- consistência com o padrão do repositório, não necessidade de backfill.
--
-- Este arquivo é aplicado INTEIRO dentro de uma transação pelo runner
-- (src/db/migrator.ts). Não contém meta-comandos do psql.
-- =============================================================================

-- =============================================================================
-- 1. exam_packages
-- =============================================================================
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

-- =============================================================================
-- 2. exam_package_items — exames incluídos (M:N)
-- =============================================================================
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

-- =============================================================================
-- 3. exam_package_prices — preço por (pacote, convênio)
-- =============================================================================
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
