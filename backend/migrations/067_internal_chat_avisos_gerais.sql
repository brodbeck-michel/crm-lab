-- =============================================================================
-- 067_internal_chat_avisos_gerais.sql
-- CRMLAB-146 (D-318): o chat interno deixa de ser o lugar da aprovacao de
-- desconto. O canal de pedidos (`aprovacoes`) vira o canal de avisos de todos.
--
-- 1. Posts de sistema de aprovacao (pedido, APROVADO, REJEITADO), os que tem
--    proposta anexada, saem do canal e vao para
--    `internal_messages_approval_archive`. O historico fica no banco e na
--    auditoria da proposta, mas nao aparece nem conta como nao lido.
-- 2. `aprovacoes` -> chave `avisos`, nome `Avisos gerais`.
-- 3. `#geral` -> `Geral`.
-- Idempotente: rodar de novo nao move nem renomeia nada.
-- =============================================================================

CREATE TABLE IF NOT EXISTS internal_messages_approval_archive (
  LIKE internal_messages INCLUDING DEFAULTS
);

ALTER TABLE internal_messages_approval_archive
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'internal_messages_approval_archive_pkey'
  ) THEN
    ALTER TABLE internal_messages_approval_archive
      ADD CONSTRAINT internal_messages_approval_archive_pkey PRIMARY KEY (id);
    ALTER TABLE internal_messages_approval_archive
      ADD CONSTRAINT internal_messages_approval_archive_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE internal_messages_approval_archive ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS internal_messages_approval_archive_tenant_isolation
  ON internal_messages_approval_archive;
CREATE POLICY internal_messages_approval_archive_tenant_isolation
  ON internal_messages_approval_archive
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

INSERT INTO internal_messages_approval_archive
SELECT m.*
  FROM internal_messages m
  JOIN internal_channels ch ON ch.id = m.channel_id
 WHERE ch.kind = 'channel'
   AND ch.key = 'aprovacoes'
   AND m.is_system
   AND m.attached_proposal_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

DELETE FROM internal_messages m
 USING internal_channels ch
 WHERE ch.id = m.channel_id
   AND ch.kind = 'channel'
   AND ch.key = 'aprovacoes'
   AND m.is_system
   AND m.attached_proposal_id IS NOT NULL;

UPDATE internal_channels
   SET key = 'avisos', name = 'Avisos gerais'
 WHERE kind = 'channel' AND key = 'aprovacoes';

UPDATE internal_channels
   SET name = 'Geral'
 WHERE kind = 'channel' AND key = 'geral' AND name = '#geral';
