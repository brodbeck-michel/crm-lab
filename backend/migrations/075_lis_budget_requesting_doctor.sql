-- =============================================================================
-- 075_lis_budget_requesting_doctor.sql
-- CRMLAB-198 (D-335): medico solicitante da requisicao, vindo da API de
-- Orcamentos do Bitlab (MEDICO_SOLICITANTE, CONSELHO_MEDICO, CRM_MEDICO,
-- UF_CRM_MEDICO). SCHEMA.md §53.
--
-- So DDL, aditiva, sem backfill: o medico chega quando o Bitlab reenvia o
-- orcamento. Sem CHECK: a normalizacao e na borda (toLisRow), e valor estranho
-- vira NULL em vez de derrubar o chunk da sync. O vinculo com `doctors` e por
-- join na leitura (crm + uf), por isso o indice parcial.
-- Idempotente (IF NOT EXISTS).
-- =============================================================================

ALTER TABLE lis_budgets
  ADD COLUMN IF NOT EXISTS requesting_doctor_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS requesting_doctor_council VARCHAR(10),
  ADD COLUMN IF NOT EXISTS requesting_doctor_crm VARCHAR(20),
  ADD COLUMN IF NOT EXISTS requesting_doctor_uf CHAR(2);

CREATE INDEX IF NOT EXISTS idx_lis_budgets_tenant_doctor_crm
  ON lis_budgets(tenant_id, requesting_doctor_crm, requesting_doctor_uf)
  WHERE requesting_doctor_crm IS NOT NULL;
