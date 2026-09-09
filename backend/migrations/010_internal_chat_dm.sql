-- =============================================================================
-- 010_internal_chat_dm.sql
-- Mensagens diretas (DM) no chat interno — D-101, SCHEMA.md §11, SERVICES.md §7.
--
-- `internal_channels` ja previa `kind = 'dm'` desde a migracao 001, mas nenhum
-- codigo criava esse tipo de canal e nao havia como registrar QUEM sao os dois
-- participantes. Este arquivo so adiciona colunas a uma tabela existente — nao
-- precisa de GRANT (a tabela ja foi concedida a `crm_app` em 001/002) nem de
-- policy nova (RLS e por linha, cobre colunas novas automaticamente).
--
-- `dm_user_a_id < dm_user_b_id` e o par ordenado canonico: garante uma unica
-- linha por combinacao de dois usuarios sem depender de parsear a `key`
-- (`dm:{menorId}:{maiorId}`, D-101). O CHECK faz as duas formas (channel/dm)
-- se excluirem mutuamente — impossivel um canal comum ter participantes, ou
-- uma DM nascer sem os dois.
-- =============================================================================

ALTER TABLE internal_channels
  ADD COLUMN dm_user_a_id UUID REFERENCES users(id),
  ADD COLUMN dm_user_b_id UUID REFERENCES users(id);

ALTER TABLE internal_channels ADD CONSTRAINT internal_channels_dm_shape CHECK (
  (kind = 'dm' AND dm_user_a_id IS NOT NULL AND dm_user_b_id IS NOT NULL
    AND dm_user_a_id < dm_user_b_id)
  OR
  (kind = 'channel' AND dm_user_a_id IS NULL AND dm_user_b_id IS NULL)
);

-- Usados pelo filtro de visibilidade de `listChannels`/`findChannelById`
-- (SERVICES.md §7, D-101): `WHERE kind = 'channel' OR $userId IN (dm_user_a_id, dm_user_b_id)`.
CREATE INDEX idx_internal_channels_dm_a ON internal_channels(dm_user_a_id);
CREATE INDEX idx_internal_channels_dm_b ON internal_channels(dm_user_b_id);
