-- =============================================================================
-- 032_lis_budget_payments.sql
-- CRMLAB-53 (D-188/D-189): extrato de pagamentos do LIS e releitura diaria.
-- SCHEMA.md §26a (lis_budget_payments) e §31 (lis_sync_settings).
--
-- Arquivo UNICO (tabela + policy), como a 026: nao ha backfill. A carga
-- anterior nao tem hora nem ID de pagamento; o extrato nasce na primeira
-- rodada depois do deploy (recarga de 90 dias com a marca zerada).
-- =============================================================================

-- Uma linha por pagamento. `payment_key` = ID_PAGAMENTO do Bitlab, ou
-- 'planilha:<paid_at>:<valor>' para a planilha, que nao tem ID (D-188 item 2).
CREATE TABLE lis_budget_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  budget_number VARCHAR(50) NOT NULL,
  requisition_number VARCHAR(50) NULL,
  payment_key VARCHAR(80) NOT NULL,
  source VARCHAR(10) NOT NULL CHECK (source IN ('api', 'planilha')),
  paid_at TIMESTAMP NULL,                -- sem fuso, relogio de Brasilia (D-187)
  paid_value NUMERIC(12, 2) NOT NULL,
  status VARCHAR(10) NOT NULL CHECK (status IN ('ativo', 'estornado')),
  reversed_at TIMESTAMP NULL,
  payment_method VARCHAR(60) NULL,
  card_brand VARCHAR(60) NULL,
  import_id UUID NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (import_id) REFERENCES lis_imports(id) ON DELETE SET NULL,
  CONSTRAINT lis_budget_payments_key UNIQUE (tenant_id, budget_number, payment_key)
);

CREATE INDEX idx_lis_budget_payments_import ON lis_budget_payments(import_id);

CREATE TRIGGER trg_lis_budget_payments_updated_at
  BEFORE UPDATE ON lis_budget_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE lis_budget_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY lis_budget_payments_tenant_isolation ON lis_budget_payments
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Dia (Brasilia) da ultima releitura completa que terminou sem erro (D-189 item 2).
ALTER TABLE lis_sync_settings ADD COLUMN last_full_scan_on DATE NULL;
