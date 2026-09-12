-- =============================================================================
-- 012_lis_domain.sql
-- Onda 9 — domínio "Orçamentos do LIS" herdado do FluxoLab: attendants,
-- lis_imports, lis_budgets, sales + ALTERs de suporte em tenant_settings,
-- insurances e proposals.
--
-- Fonte: docs/database/SCHEMA.md §24-27 · docs/domain/BUSINESS_RULES.md §11 ·
--        docs/DECISIONS.md D-109 a D-115, D-118 ·
--        docs/superpowers/specs/2026-09-08-fusao-crm-fluxolab-design.md
--        (seção "Onda 9").
--
-- GENERATED ALWAYS AS ... STORED validado em PGlite 0.2.17 (D-008) antes de
-- escrever este arquivo: coluna gerada simples (soma) e coluna gerada com
-- CASE sobre múltiplas colunas funcionam normalmente, inclusive em UPDATE e
-- em ON CONFLICT ... WHERE referenciando a coluna base. Nenhum fallback de
-- cálculo no repositório foi necessário — ver nota em docs/STATUS.md.
--
-- O RLS das 4 tabelas novas fica na 013_rls_lis_domain.sql, de propósito —
-- mesmo padrão da dupla 003/004, 005/006: nenhuma linha é escrita por esta
-- migração, então a separação aqui é consistência com o padrão do
-- repositório, não necessidade de backfill.
--
-- Este arquivo é aplicado INTEIRO dentro de uma transação pelo runner
-- (src/db/migrator.ts). Não contém meta-comandos do psql.
-- =============================================================================

-- =============================================================================
-- 1. attendants — atendente do LIS (SCHEMA.md §24, D-112)
--
-- O USUÁRIO da planilha de orçamentos vira attendant_id; ligar a um users.id
-- (login no CRM) é opcional e manual. folded_name (D-111) dedupe "Maria
-- Souza"/"maria souza"/"Maria  Souza" — acento NÃO é removido (risco
-- registrado no spec, decisão futura).
-- =============================================================================
CREATE TABLE attendants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  folded_name VARCHAR(255) GENERATED ALWAYS AS (
    lower(regexp_replace(trim(name), '\s+', ' ', 'g'))
  ) STORED,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  user_id UUID NULL,                     -- opcional: liga o atendente a um login do CRM
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, folded_name)
);

CREATE INDEX idx_attendants_tenant_id ON attendants(tenant_id);
CREATE INDEX idx_attendants_user_id ON attendants(user_id);

CREATE TRIGGER trg_attendants_updated_at
  BEFORE UPDATE ON attendants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 2. lis_imports — histórico imutável de importação/limpeza (SCHEMA.md §25,
--    D-109)
--
-- Sem DELETE na API — log de auditoria da própria importação, não dado de
-- trabalho.
-- =============================================================================
CREATE TABLE lis_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  kind VARCHAR(20) NOT NULL,             -- CHECK: import | purge
  file_name VARCHAR(255),                -- NULL em kind='purge'
  rows_in_file INT,
  rows_accepted INT,
  rows_rejected INT,
  proposals_won INT,                     -- preenchido só a partir da Onda 13 (D-118)
  status VARCHAR(20) NOT NULL DEFAULT 'processing', -- CHECK: processing | completed | failed
  error_message TEXT,
  created_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  finished_at TIMESTAMP NULL,

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (kind IN ('import', 'purge')),
  CHECK (status IN ('processing', 'completed', 'failed'))
);

CREATE INDEX idx_lis_imports_tenant_id ON lis_imports(tenant_id);
CREATE INDEX idx_lis_imports_tenant_created ON lis_imports(tenant_id, created_at DESC);

-- =============================================================================
-- 3. lis_budgets — orçamento do LIS deduplicado e consolidado (SCHEMA.md §26,
--    D-110/D-111/D-114, BUSINESS_RULES.md §11)
--
-- Uma linha por UNIQUE (tenant_id, number). principal_insurance_name e
-- total_value são GENERATED ... STORED (validado em PGlite, ver cabeçalho
-- deste arquivo) — regra de negócio pura sobre insurance_1..3/value_1..3,
-- calculada uma única vez no banco em vez de duplicada em todo caminho de
-- escrita (seed, import, correção manual futura).
-- =============================================================================
CREATE TABLE lis_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  number VARCHAR(50) NOT NULL,           -- coluna ORCAMENTO da planilha (obrigatória)
  issued_on DATE,                        -- DATA_ORÇAMENTO (D-110: DATE, não TIMESTAMP)
  patient_name VARCHAR(255),             -- NM_PACIENTE — dado pessoal sem patient_id (§6 do spec)

  insurance_1 VARCHAR(255),              -- CONVENIO1
  value_1 NUMERIC(12,2),                 -- VL_TOTAL1
  insurance_2 VARCHAR(255),              -- CONVENIO2
  value_2 NUMERIC(12,2),                 -- VL_TOTAL2
  insurance_3 VARCHAR(255),              -- CONVENIO3
  value_3 NUMERIC(12,2),                 -- VL_TOTAL3

  principal_insurance_name VARCHAR(255) GENERATED ALWAYS AS (
    CASE
      WHEN insurance_1 IS NOT NULL AND COALESCE(value_1, 0) > 0 THEN insurance_1
      WHEN insurance_2 IS NOT NULL AND COALESCE(value_2, 0) > 0 THEN insurance_2
      WHEN insurance_3 IS NOT NULL AND COALESCE(value_3, 0) > 0 THEN insurance_3
      WHEN insurance_1 IS NOT NULL THEN insurance_1
      WHEN insurance_2 IS NOT NULL THEN insurance_2
      WHEN insurance_3 IS NOT NULL THEN insurance_3
      ELSE NULL
    END
  ) STORED,
  total_value NUMERIC(12,2) GENERATED ALWAYS AS (
    COALESCE(value_1, 0) + COALESCE(value_2, 0) + COALESCE(value_3, 0)
  ) STORED,

  insurance_id UUID NULL,                -- convênio resolvido; NULL = particular (D-082/D-114)
  attendant_name VARCHAR(255),           -- USUÁRIO/USUARIO cru da planilha
  attendant_id UUID NULL,                -- atendente resolvido (§24)
  insurance_average NUMERIC(12,2),       -- MEDIA_CONVENIO

  requisition_number VARCHAR(50),        -- REQUISICAO (5 aliases na planilha)
  requisition_value NUMERIC(12,2),       -- VALOR_REQUISICAO
  paid_value NUMERIC(12,2),              -- Valor_Pago (3 aliases)
  paid_on DATE,                          -- DATA_PAGAMENTO (5 aliases; D-110: DATE)

  import_id UUID NOT NULL,               -- importação que gravou/atualizou esta linha por último
  proposal_id UUID NULL,                 -- conciliação (Onda 13, D-119) — nasce NULL nesta onda

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (insurance_id) REFERENCES insurances(id),
  FOREIGN KEY (attendant_id) REFERENCES attendants(id),
  FOREIGN KEY (import_id) REFERENCES lis_imports(id),
  FOREIGN KEY (proposal_id) REFERENCES proposals(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, number)
);

CREATE INDEX idx_lis_budgets_tenant_issued ON lis_budgets(tenant_id, issued_on);
CREATE INDEX idx_lis_budgets_tenant_paid ON lis_budgets(tenant_id, paid_on) WHERE paid_value > 0;
CREATE INDEX idx_lis_budgets_tenant_requisition ON lis_budgets(tenant_id, requisition_number);
CREATE INDEX idx_lis_budgets_tenant_attendant ON lis_budgets(tenant_id, attendant_id);

CREATE TRIGGER trg_lis_budgets_updated_at
  BEFORE UPDATE ON lis_budgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 4. sales — vendas avulsas (exames e check-ups) para cálculo de comissão
--    (SCHEMA.md §27)
-- =============================================================================
CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  attendant_id UUID NOT NULL,
  sold_on DATE NOT NULL,
  code VARCHAR(50),
  value NUMERIC(12,2) NOT NULL,
  exams TEXT,                            -- texto livre (nomes dos exames vendidos)
  kind VARCHAR(20) NOT NULL,             -- CHECK: exams | checkup
  created_by UUID,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (attendant_id) REFERENCES attendants(id),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (value > 0),
  CHECK (kind IN ('exams', 'checkup'))
);

CREATE INDEX idx_sales_tenant_id ON sales(tenant_id);
CREATE INDEX idx_sales_tenant_sold_on ON sales(tenant_id, sold_on);
CREATE INDEX idx_sales_attendant_id ON sales(attendant_id);

CREATE TRIGGER trg_sales_updated_at
  BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 5. tenant_settings — percentuais de comissão (D-113)
--
-- Defaults são os percentuais validados em produção pelo FluxoLab (2% / 1,5%
-- / 1,5% — antes por-navegador em localStorage, agora por-tenant e por-linha).
-- =============================================================================
ALTER TABLE tenant_settings
  ADD COLUMN commission_budget_pct NUMERIC(5,2) NOT NULL DEFAULT 2.00,
  ADD COLUMN commission_exams_pct NUMERIC(5,2) NOT NULL DEFAULT 1.50,
  ADD COLUMN commission_checkup_pct NUMERIC(5,2) NOT NULL DEFAULT 1.50;

-- =============================================================================
-- 6. insurances — type = 'outro' e source (D-114)
--
-- type = 'outro' é gravado quando o convênio nasce da resolução automática
-- de lis_budgets (D-114); source = 'lis' marca a origem, espelhando
-- exam_catalog.source (§7, D-081). DEFAULT cobre as linhas existentes sem
-- backfill.
-- =============================================================================
ALTER TABLE insurances
  DROP CONSTRAINT insurances_type_check,
  ADD CONSTRAINT insurances_type_check
    CHECK (type IN ('cooperativa', 'medicina_grupo', 'seguradora', 'autogestao', 'especial', 'outro')),
  ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'manual',
  ADD CONSTRAINT insurances_source_check CHECK (source IN ('manual', 'lis'));

-- =============================================================================
-- 7. proposals — colunas de conciliação com o LIS, criadas agora, usadas só
--    na Onda 13 (D-118)
--
-- As cinco colunas nascem NULL em toda proposta; nenhuma rota desta onda as
-- escreve. O índice único parcial já impede duas propostas disputarem o
-- mesmo número de orçamento do LIS desde já, mesmo sem caminho de escrita
-- ligado ainda.
-- =============================================================================
ALTER TABLE proposals
  ADD COLUMN lis_budget_number VARCHAR(50),
  ADD COLUMN lis_requisition_number VARCHAR(50),
  ADD COLUMN lis_paid_value NUMERIC(12,2),
  ADD COLUMN lis_paid_on DATE,
  ADD COLUMN lis_reconciled_at TIMESTAMP;

CREATE UNIQUE INDEX idx_proposals_tenant_lis_budget_number
  ON proposals(tenant_id, lis_budget_number)
  WHERE lis_budget_number IS NOT NULL;
