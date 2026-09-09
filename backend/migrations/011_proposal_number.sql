-- =============================================================================
-- 011_proposal_number.sql
-- Numero sequencial de orcamento, POR TENANT — pedido de rastreamento: o UUID
-- da proposta nao e citavel por telefone/WhatsApp, o numero e.
--
-- Sequencial por tenant (nao global): dois laboratorios nao competem pelo
-- mesmo contador, e o primeiro orcamento de cada tenant novo comeca em 1 —
-- mesma convencao ja usada pelo resto do schema (RLS por tenant_id,
-- CLAUDE.md regra 1). Backfill via ROW_NUMBER() particionado por tenant,
-- ordenado pela ordem real de criacao (mesmo criterio de
-- 003_patients_and_channels.sql).
--
-- A contagem do PROXIMO numero (repository, `insertProposal`) usa
-- `pg_advisory_xact_lock` sobre o tenant dentro da MESMA transacao do INSERT
-- — sem tabela de contador dedicada: `MAX(proposal_number) + 1` sob a trava
-- e suficiente para o volume de um laboratorio, e a trava e liberada sozinha
-- no COMMIT/ROLLBACK.
-- =============================================================================

ALTER TABLE proposals ADD COLUMN proposal_number INTEGER;

UPDATE proposals p
   SET proposal_number = numbered.rn
  FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn
      FROM proposals
  ) numbered
 WHERE numbered.id = p.id;

ALTER TABLE proposals ALTER COLUMN proposal_number SET NOT NULL;

CREATE UNIQUE INDEX idx_proposals_tenant_number ON proposals(tenant_id, proposal_number);
