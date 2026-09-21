-- =============================================================================
-- 021_fk_indexes.sql
-- CRMLAB-38 item 2 (D-146): indice nas 15 FKs sem indice encontradas em
-- producao (SEQ SCAN em DELETE/JOIN quando o banco crescer; hoje 13 MB,
-- irrelevante, mas o custo de esperar e so aumentar).
--
-- SEM `CONCURRENTLY`: o migrator (`backend/src/db/migrator.ts`) roda cada
-- arquivo dentro de uma transacao propria, e `CREATE INDEX CONCURRENTLY` nao
-- pode rodar dentro de transacao. Com o volume atual do banco a criacao e
-- instantanea mesmo bloqueando a tabela por uma fracao de segundo — o proprio
-- card reconhece isso. Reavaliar `CONCURRENTLY` (exigiria suporte a migracao
-- fora de transacao no migrator) se o volume crescer a ponto do lock incomodar
-- em producao.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_proposals_created_by ON proposals(created_by);
CREATE INDEX IF NOT EXISTS idx_proposals_approved_by ON proposals(approved_by);
CREATE INDEX IF NOT EXISTS idx_proposals_insurance_id ON proposals(insurance_id);
CREATE INDEX IF NOT EXISTS idx_proposal_items_exam_id ON proposal_items(exam_id);
CREATE INDEX IF NOT EXISTS idx_proposal_status_history_changed_by ON proposal_status_history(changed_by);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_internal_messages_sender_id ON internal_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_internal_messages_attached_proposal_id ON internal_messages(attached_proposal_id);
CREATE INDEX IF NOT EXISTS idx_tenant_channels_accepted_terms_by ON tenant_channels(accepted_terms_by);
CREATE INDEX IF NOT EXISTS idx_quick_replies_created_by ON quick_replies(created_by);
CREATE INDEX IF NOT EXISTS idx_message_media_message_id ON message_media(message_id);
CREATE INDEX IF NOT EXISTS idx_lis_imports_created_by ON lis_imports(created_by);
CREATE INDEX IF NOT EXISTS idx_lis_budgets_insurance_id ON lis_budgets(insurance_id);
CREATE INDEX IF NOT EXISTS idx_lis_budgets_import_id ON lis_budgets(import_id);
