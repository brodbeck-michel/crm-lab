-- =============================================================================
-- 076_lis_requisitions.sql
-- CRMLAB-200 (D-338): requisicoes do Bitlab (todas, com ou sem orcamento),
-- fonte do faturamento por medico. SCHEMA.md §54 e §31.
--
-- Tabelas + RLS no MESMO arquivo (AGENTS.md: tabela sem policy vaza). Sem
-- backfill: a carga inicial vem pela API (LisRequisitionSyncService).
-- Idempotente (IF NOT EXISTS).
-- =============================================================================

-- Uma linha por requisicao. A requisicao alterada volta inteira do Bitlab e
-- SUBSTITUI a gravada (pagamentos inclusive). Datas sem fuso, relogio de
-- Brasilia (D-187), como o resto do LIS.
CREATE TABLE IF NOT EXISTS lis_requisitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  number VARCHAR(50) NOT NULL,
  requested_at TIMESTAMP NULL,
  requested_on DATE NULL,
  budget_number VARCHAR(50) NULL,
  insurance_code VARCHAR(30) NULL,
  insurance_name VARCHAR(255) NULL,
  insurance_type VARCHAR(20) NULL,       -- Particular | Convenio | Hibrido (cru do Bitlab)
  insurance_id UUID NULL,                -- resolvido pelo nome (BUSINESS_RULES §11.4); PARTICULAR = NULL
  attendant_name VARCHAR(255) NULL,
  attendant_id UUID NULL,                -- resolvido pelo nome (§11.6), nunca criado
  requesting_doctor_name VARCHAR(255) NULL,
  requesting_doctor_council VARCHAR(10) NULL,
  requesting_doctor_crm VARCHAR(20) NULL,
  requesting_doctor_uf CHAR(2) NULL,
  patient_value NUMERIC(12, 2) NOT NULL DEFAULT 0,   -- valorCobrado - descontos + acrescimos
  insurance_value NUMERIC(12, 2) NOT NULL DEFAULT 0, -- faturamentoConvenio.valorConvenio
  total_value NUMERIC(12, 2) GENERATED ALWAYS AS (patient_value + insurance_value) STORED,
  paid_value NUMERIC(12, 2) NOT NULL DEFAULT 0,      -- cobrancaPaciente.valorPago (informativo)
  changed_at TIMESTAMP NULL,             -- dataAlteracao do Bitlab
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (insurance_id) REFERENCES insurances(id) ON DELETE SET NULL,
  FOREIGN KEY (attendant_id) REFERENCES attendants(id) ON DELETE SET NULL,
  CONSTRAINT lis_requisitions_number_key UNIQUE (tenant_id, number)
);

CREATE INDEX IF NOT EXISTS idx_lis_requisitions_tenant_requested
  ON lis_requisitions(tenant_id, requested_on);
CREATE INDEX IF NOT EXISTS idx_lis_requisitions_tenant_doctor_crm
  ON lis_requisitions(tenant_id, requesting_doctor_crm, requesting_doctor_uf)
  WHERE requesting_doctor_crm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lis_requisitions_insurance ON lis_requisitions(insurance_id);
CREATE INDEX IF NOT EXISTS idx_lis_requisitions_attendant ON lis_requisitions(attendant_id);

DROP TRIGGER IF EXISTS trg_lis_requisitions_updated_at ON lis_requisitions;
CREATE TRIGGER trg_lis_requisitions_updated_at
  BEFORE UPDATE ON lis_requisitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE lis_requisitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lis_requisitions_tenant_isolation ON lis_requisitions;
CREATE POLICY lis_requisitions_tenant_isolation ON lis_requisitions
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Pagamentos do paciente. Apagados e regravados junto com a requisicao.
CREATE TABLE IF NOT EXISTS lis_requisition_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  requisition_id UUID NOT NULL,
  payment_key VARCHAR(80) NOT NULL,      -- id do pagamento no Bitlab
  paid_at TIMESTAMP NULL,
  paid_on DATE NULL,
  paid_value NUMERIC(12, 2) NOT NULL,
  status VARCHAR(10) NOT NULL CHECK (status IN ('ativo', 'estornado')),
  payment_method VARCHAR(60) NULL,
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (requisition_id) REFERENCES lis_requisitions(id) ON DELETE CASCADE,
  CONSTRAINT lis_requisition_payments_key UNIQUE (requisition_id, payment_key)
);

CREATE INDEX IF NOT EXISTS idx_lis_requisition_payments_tenant_paid
  ON lis_requisition_payments(tenant_id, paid_on) WHERE status = 'ativo';

ALTER TABLE lis_requisition_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lis_requisition_payments_tenant_isolation ON lis_requisition_payments;
CREATE POLICY lis_requisition_payments_tenant_isolation ON lis_requisition_payments
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Estado da sincronizacao de requisicoes, na mesma linha da de orcamentos
-- (mesma chave, mesmo liga/desliga). D-338 item 6.
ALTER TABLE lis_sync_settings
  ADD COLUMN IF NOT EXISTS requisitions_watermark VARCHAR(30) NULL,
  ADD COLUMN IF NOT EXISTS requisitions_cursor VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS requisitions_load_next_day DATE NULL,
  ADD COLUMN IF NOT EXISTS requisitions_load_started_at VARCHAR(30) NULL,
  ADD COLUMN IF NOT EXISTS requisitions_last_run_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS requisitions_last_success_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS requisitions_last_error TEXT NULL;
