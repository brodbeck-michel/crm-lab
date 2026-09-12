-- =============================================================================
-- 014_fix_lis_budgets_total_value.sql
--
-- Corrige a formula de `lis_budgets.total_value`, gerada errada em
-- 012_lis_domain.sql. Migracao ja aplicada nunca e editada (docs/AGENTS.md,
-- docs/guides/DEVELOPMENT.md) — a correcao entra aqui, como nova migracao.
--
-- O BUG (achado comparando com o app de referencia do FluxoLab,
-- orcamentos-sante-main/src/lib/orcamento.ts): `total_value` foi implementada
-- como SOMA de `value_1 + value_2 + value_3`. Isso esta ERRADO —
-- `insurance_2`/`insurance_3` + `value_2`/`value_3` sao COTACOES ALTERNATIVAS
-- do MESMO orcamento (o mesmo exame precificado por convenios diferentes),
-- nao valores adicionais a somar. O valor de referencia do orcamento e o do
-- CONVENIO PRINCIPAL (mesma seleção de `principal_insurance_name`, BUSINESS_
-- RULES.md §11.3) — nunca a soma dos tres.
--
-- Consequencia do bug: "Total Orcado" (e tudo que deriva dele — byInsurance,
-- monthlySeries.issuedValue, o proprio total_value gravado) saia INFLADO em
-- qualquer orcamento com mais de uma cotacao de convenio preenchida. E a causa
-- raiz do usuario reportar numeros da Onda 10 divergentes da producao real.
--
-- FIX: DROP + ADD do campo GERADO (Postgres nao permite ALTER da expressao de
-- uma coluna GENERATED; drop+add e o caminho suportado, e recalcula os valores
-- ja gravados automaticamente no ADD). Mesma ordem de prioridade de
-- `principal_insurance_name` — c1 com nome+valor>0, senao c2, senao c3, senao
-- o primeiro com nome (valor 0). D-124.
-- =============================================================================

ALTER TABLE lis_budgets DROP COLUMN total_value;

ALTER TABLE lis_budgets ADD COLUMN total_value NUMERIC(12,2) GENERATED ALWAYS AS (
  CASE
    WHEN insurance_1 IS NOT NULL AND COALESCE(value_1, 0) > 0 THEN value_1
    WHEN insurance_2 IS NOT NULL AND COALESCE(value_2, 0) > 0 THEN value_2
    WHEN insurance_3 IS NOT NULL AND COALESCE(value_3, 0) > 0 THEN value_3
    WHEN insurance_1 IS NOT NULL THEN COALESCE(value_1, 0)
    WHEN insurance_2 IS NOT NULL THEN COALESCE(value_2, 0)
    WHEN insurance_3 IS NOT NULL THEN COALESCE(value_3, 0)
    -- Nenhum dos tres tem nome de convenio: usa o primeiro valor > 0 mesmo
    -- sem nome, igual ao app de referencia (opts.find(o => o.v > 0)).
    WHEN COALESCE(value_1, 0) > 0 THEN value_1
    WHEN COALESCE(value_2, 0) > 0 THEN value_2
    WHEN COALESCE(value_3, 0) > 0 THEN value_3
    ELSE 0
  END
) STORED;
