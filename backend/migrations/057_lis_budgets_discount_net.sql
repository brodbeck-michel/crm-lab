-- =============================================================================
-- 057_lis_budgets_discount_net.sql
-- CRMLAB-114 (D-278): desconto, acrescimo e valor liquido do orcamento do
-- Bitlab. SCHEMA.md §26.
--
-- Desde 23/10/2026 a API de orcamentos (SERVICES.md §24.1) manda, por convenio
-- n=1,2,3: `PER_DESCONTO{n}` (percentual, so informativo), `VL_DESCONTO{n}`,
-- `VL_ACRESCIMO{n}` e `VL_APAGAR{n}` (liquido = VL_TOTAL - VL_DESCONTO +
-- VL_ACRESCIMO). A verdade e o valor em reais: o orc. 71197 de prod veio com
-- PER_DESCONTO1 = 0 e VL_DESCONTO1 = 10,62.
--
-- `total_value` (bruto, D-124) NAO muda — nenhum numero antigo muda sem aviso.
-- O liquido nasce AO LADO, em `net_value`, com a MESMA selecao de convenio
-- principal da 014 (e de `principal_insurance_name`): o `VL_APAGAR` do
-- convenio escolhido, e o bruto dele quando o `VL_APAGAR` nao veio (planilha,
-- API antiga, orcamento ainda nao ressincronizado) — sem os campos, liquido =
-- bruto. Coluna GERADA como a `total_value`: a regra mora num lugar so e o
-- ADD ja preenche toda linha existente (com o bruto, ate a proxima sync).
--
-- Tabela ja tem RLS (013); colunas novas herdam a policy. Todas NULL: a
-- planilha nao tem essas colunas e continua importando igual.
--
-- `discount_percent_n` e NUMERIC(9,4), largo de proposito: o percentual e so
-- informativo, e um valor fora do esperado nao pode derrubar o upsert.
-- =============================================================================

ALTER TABLE lis_budgets
  ADD COLUMN discount_percent_1 NUMERIC(9,4),   -- PER_DESCONTO1
  ADD COLUMN discount_value_1   NUMERIC(12,2),  -- VL_DESCONTO1
  ADD COLUMN surcharge_value_1  NUMERIC(12,2),  -- VL_ACRESCIMO1
  ADD COLUMN payable_value_1    NUMERIC(12,2),  -- VL_APAGAR1
  ADD COLUMN discount_percent_2 NUMERIC(9,4),
  ADD COLUMN discount_value_2   NUMERIC(12,2),
  ADD COLUMN surcharge_value_2  NUMERIC(12,2),
  ADD COLUMN payable_value_2    NUMERIC(12,2),
  ADD COLUMN discount_percent_3 NUMERIC(9,4),
  ADD COLUMN discount_value_3   NUMERIC(12,2),
  ADD COLUMN surcharge_value_3  NUMERIC(12,2),
  ADD COLUMN payable_value_3    NUMERIC(12,2);

-- Mesmo CASE da 014, trocando `value_n` por `COALESCE(payable_value_n, value_n)`
-- no convenio escolhido. A ESCOLHA do convenio continua pelo bruto (`value_n`),
-- senao bruto e liquido poderiam apontar para convenios diferentes.
ALTER TABLE lis_budgets ADD COLUMN net_value NUMERIC(12,2) GENERATED ALWAYS AS (
  CASE
    WHEN insurance_1 IS NOT NULL AND COALESCE(value_1, 0) > 0 THEN COALESCE(payable_value_1, value_1)
    WHEN insurance_2 IS NOT NULL AND COALESCE(value_2, 0) > 0 THEN COALESCE(payable_value_2, value_2)
    WHEN insurance_3 IS NOT NULL AND COALESCE(value_3, 0) > 0 THEN COALESCE(payable_value_3, value_3)
    WHEN insurance_1 IS NOT NULL THEN COALESCE(payable_value_1, value_1, 0)
    WHEN insurance_2 IS NOT NULL THEN COALESCE(payable_value_2, value_2, 0)
    WHEN insurance_3 IS NOT NULL THEN COALESCE(payable_value_3, value_3, 0)
    WHEN COALESCE(value_1, 0) > 0 THEN COALESCE(payable_value_1, value_1)
    WHEN COALESCE(value_2, 0) > 0 THEN COALESCE(payable_value_2, value_2)
    WHEN COALESCE(value_3, 0) > 0 THEN COALESCE(payable_value_3, value_3)
    ELSE 0
  END
) STORED;
