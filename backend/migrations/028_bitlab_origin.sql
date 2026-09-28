-- =============================================================================
-- 028_bitlab_origin.sql
-- CRMLAB-57 (D-195/D-196): a proposta nasce do orçamento do Bitlab.
--
-- SCHEMA.md §5 (proposals.origin, conversation_id/created_by nulláveis),
-- §16 (tenant_settings.bitlab_proposals_since) e §25
-- (lis_imports.proposals_created).
--
-- Sem backfill: toda proposta existente é origem 'crm' (DEFAULT) e continua
-- com conversa e autor — o CHECK abaixo garante isso para sempre. A marca
-- `bitlab_proposals_since` NÃO é preenchida aqui: ela nasce na primeira
-- ingestão com a regra ligada (D-196 item 2), e é ela que impede que o
-- histórico de `lis_budgets` já gravado vire cartão.
--
-- Sem tabela nova, sem policy nova: as três tabelas já têm RLS.
-- =============================================================================

ALTER TABLE proposals
  ADD COLUMN origin VARCHAR(20) NOT NULL DEFAULT 'crm',
  ADD CONSTRAINT proposals_origin_check CHECK (origin IN ('crm', 'bitlab'));

ALTER TABLE proposals ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE proposals ALTER COLUMN created_by DROP NOT NULL;

-- Só a origem 'bitlab' pode nascer sem conversa e sem responsável.
ALTER TABLE proposals
  ADD CONSTRAINT proposals_crm_origin_complete
    CHECK (origin <> 'crm' OR (conversation_id IS NOT NULL AND created_by IS NOT NULL));

-- Dia (Brasília) a partir do qual orçamento emitido vira proposta. NULL = ainda
-- não ativado neste laboratório.
ALTER TABLE tenant_settings ADD COLUMN bitlab_proposals_since DATE NULL;

-- Quantas propostas a rodada criou (D-196 item 4). NULL nas linhas antigas.
ALTER TABLE lis_imports ADD COLUMN proposals_created INT NULL;
