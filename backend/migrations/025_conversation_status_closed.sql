-- =============================================================================
-- 025_conversation_status_closed.sql
-- CRMLAB-48 (D-174): "Arquivar" e "Encerrar" viram uma coisa so.
--
-- `conversations.status` passa a ter dois valores, `active | closed`. As
-- conversas arquivadas ate aqui sao exatamente o que o produto agora chama de
-- encerradas (fora da fila, composer travado), entao migram para `closed` —
-- e passam a reabrir quando o paciente voltar a escrever, como qualquer outra.
--
-- O CHECK fecha a porta para `archived` (ou qualquer outro texto) voltar pelo
-- banco: ate aqui a coluna era VARCHAR livre e so o zod da rota segurava.
-- Mesmo padrao do backfill de 003: a migracao roda como dono da tabela, e o
-- RLS de 002 nao e FORCE, entao o UPDATE enxerga todos os tenants.
-- =============================================================================
UPDATE conversations SET status = 'closed', updated_at = NOW() WHERE status = 'archived';
UPDATE conversations SET status = 'active' WHERE status IS NULL;

ALTER TABLE conversations
  ALTER COLUMN status SET NOT NULL,
  ADD CONSTRAINT conversations_status_check CHECK (status IN ('active', 'closed'));
