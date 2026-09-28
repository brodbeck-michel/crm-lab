-- =============================================================================
-- 029_proposal_send_claim.sql
-- CRMLAB-58 (D-201): reserva do "Enviar orçamento" pelo cartão do Bitlab.
--
-- SCHEMA.md §5 ("Colunas novas em proposals (migração 029)").
--
-- O envio acontece em três passos: reserva (esta coluna), mensagem pelo
-- caminho do atendimento e, só com o envio aceito, o vínculo. A reserva é o que
-- faz a segunda atendente que clica "Enviar" no mesmo cartão receber erro SEM
-- mandar uma segunda mensagem ao paciente. Reserva com mais de 2 minutos é
-- considerada abandonada (queda do processo no meio do envio).
--
-- Sem backfill (NULL = sem reserva), sem tabela nova, sem policy nova.
-- =============================================================================

ALTER TABLE proposals
  ADD COLUMN send_claim_id UUID NULL,
  ADD COLUMN send_claimed_at TIMESTAMPTZ NULL;
