-- =============================================================================
-- 060_conversations_patient_name_sync.sql
-- CRMLAB-124 (D-292): corrige os dados ja gravados em que
-- `conversations.patient_name` (copia denormalizada, D-059) ficou diferente do
-- nome do cadastro em `patients.name` — caso de prod de 28/10/2026: paciente e
-- conversa nasceram sem nome pela Nova conversa e o nome do paciente foi
-- gravado 21 s depois, sem chegar a conversa.
--
-- Qual nome vale (D-072/D-287): o do CADASTRO. O nome do perfil do WhatsApp
-- nunca sobrescreve o cadastrado. Por isso:
--   - so conversa LIGADA (patient_id) a paciente do MESMO tenant;
--   - so quando o cadastro TEM nome (vazio/espacos nao apagam o da conversa);
--   - paciente anonimizado (LGPD, D-063/D-075) fica de fora.
-- Idempotente: a segunda execucao nao acha linha (IS DISTINCT FROM).
-- Sem DDL; daqui em diante o backend mantem a copia em dia (D-292).
--
-- Conferencia ANTES e DEPOIS (deve dar 0 depois):
--   SELECT c.tenant_id, c.id AS conversation_id, c.patient_name, p.name
--     FROM conversations c
--     JOIN patients p ON p.id = c.patient_id AND p.tenant_id = c.tenant_id
--    WHERE p.anonymized_at IS NULL
--      AND NULLIF(btrim(p.name), '') IS NOT NULL
--      AND c.patient_name IS DISTINCT FROM p.name
--    ORDER BY c.tenant_id, c.created_at;
-- =============================================================================

UPDATE conversations c
   SET patient_name = p.name
  FROM patients p
 WHERE p.id = c.patient_id
   AND p.tenant_id = c.tenant_id
   AND p.anonymized_at IS NULL
   AND NULLIF(btrim(p.name), '') IS NOT NULL
   AND c.patient_name IS DISTINCT FROM p.name;
