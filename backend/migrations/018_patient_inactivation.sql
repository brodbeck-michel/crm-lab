-- =============================================================================
-- 018_patient_inactivation.sql
-- Inativação de paciente (CRMLAB-11, D-132).
--
-- Mesmo desenho de `anonymized_at` (D-063): nao-nulo = estado ligado, sem
-- DELETE nem tabela de historico — o motivo de cada transicao vai para
-- `audit_logs` (`inactivate_patient`/`reactivate_patient`), nunca para a
-- propria linha.
-- =============================================================================
ALTER TABLE patients
  ADD COLUMN inactivated_at TIMESTAMP,
  ADD COLUMN inactivation_reason TEXT;
