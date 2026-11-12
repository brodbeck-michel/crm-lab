-- =============================================================================
-- 067_channel_aprovacoes_rename.sql
-- CRMLAB-146 (D-318): o canal fixo de chave `aprovacoes` passa a se chamar
-- `#avisos-gerais` na tela. So o NOME exibido muda: a CHAVE continua
-- `aprovacoes`, que e por onde o ApprovalService, os botoes [Aprovar]/[Rejeitar]
-- e o badge acham o canal. A ordem da lista (por `key`) tambem nao muda.
-- So renomeia quem ainda tem o nome padrao antigo (idempotente).
-- =============================================================================

UPDATE internal_channels
   SET name = '#avisos-gerais'
 WHERE kind = 'channel'
   AND key = 'aprovacoes'
   AND name = '#aprovacoes';
