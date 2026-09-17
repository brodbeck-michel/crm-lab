-- =============================================================================
-- 019_messages_external_id_unique.sql
-- Dedupe de mensagem recebida vira garantia do BANCO (auditoria 2026-09-17).
--
-- O dedupe existe desde a Onda 7, mas so no service
-- (`MessageService.createFromPatient`): le `findByExternalId`, e insere se nao
-- achou. Entre a leitura e o INSERT nao ha nada segurando — e o gateway
-- Evolution reentrega o MESMO evento ate 10 vezes quando nao recebe 200 a
-- tempo (462 reentregas esgotadas so na janela auditada). Duas reentregas
-- concorrentes passam as duas pela leitura e inserem as duas: o atendente ve a
-- mensagem do paciente duplicada na conversa.
--
-- Producao nao tem nenhuma duplicata hoje (verificado antes desta migracao), o
-- que torna a criacao do indice segura. O ponto e nao depender de sorte de
-- timing daqui para frente.
--
-- Escopo `(tenant_id, external_message_id)` e nao so o id: o `key.id` do
-- WhatsApp e unico por CONTA, e dois laboratorios diferentes podem legitimamente
-- receber ids iguais. Unicidade global recusaria a mensagem do segundo tenant —
-- perda de mensagem, exatamente o que esta migracao existe para evitar.
--
-- Parcial (`WHERE ... IS NOT NULL`): mensagem escrita pelo atendente no CRM nao
-- tem id externo, e `NULL` nao conflita com `NULL` no Postgres — mas o indice
-- parcial deixa isso explicito em vez de depender dessa sutileza, e ainda fica
-- menor.
-- =============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_tenant_external_id
  ON messages (tenant_id, external_message_id)
  WHERE external_message_id IS NOT NULL;
