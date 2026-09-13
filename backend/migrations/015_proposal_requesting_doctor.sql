-- =============================================================================
-- 015_proposal_requesting_doctor.sql
-- CRMLAB-9: "Médico solicitante" nas propostas/orçamentos.
--
-- Texto livre, opcional, sem cadastro/autocomplete de médicos — nasce e
-- morre como um campo de texto na proposta (SCHEMA.md §5, API_CONTRACTS.md
-- §3). Sem migração de dados: coluna nova, nullable, propostas existentes
-- ficam com o campo NULL.
-- =============================================================================

ALTER TABLE proposals ADD COLUMN requesting_doctor VARCHAR(255) NULL;
