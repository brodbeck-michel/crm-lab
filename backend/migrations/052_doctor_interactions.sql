-- =============================================================================
-- 052_doctor_interactions.sql
-- CRMLAB-89 (D-261): registros de interacao lancados a mao na ficha do medico
-- (ligacao, e-mail, WhatsApp) — card [D] do epico CRMLAB-85 (Visitacao
-- Medica). SCHEMA.md §38.
--
-- Arquivo UNICO (tabela + policy), como 047/048/050: a tabela nasce vazia,
-- nao ha backfill. Sem a policy ela VAZARIA entre laboratorios — o GRANT do
-- `ALTER DEFAULT PRIVILEGES` da 002 ja da acesso a `crm_app` no CREATE TABLE.
--
-- A linha do tempo do medico junta ESTA tabela com `doctor_visits` na leitura;
-- nada aqui copia visita. Excluir um registro apaga a linha de verdade (o
-- rastro fica no audit log, D-261 item 5).
-- =============================================================================

CREATE TABLE doctor_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  doctor_id UUID NOT NULL,
  type VARCHAR(20) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,       -- quando a interacao aconteceu (informado pelo usuario)
  description TEXT NOT NULL,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  -- Medico nao se apaga (D-255 item 4: inativa). NO ACTION deixa o CASCADE do tenant passar.
  FOREIGN KEY (doctor_id) REFERENCES doctors(id),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (type IN ('ligacao', 'email', 'whatsapp')),
  CHECK (length(trim(description)) > 0)
);

-- A linha do tempo le por medico, do mais novo para o mais antigo.
CREATE INDEX idx_doctor_interactions_doctor_occurred ON doctor_interactions(doctor_id, occurred_at DESC);
CREATE INDEX idx_doctor_interactions_tenant_id ON doctor_interactions(tenant_id);
-- Indices de FK (D-146): os ON DELETE SET NULL.
CREATE INDEX idx_doctor_interactions_created_by ON doctor_interactions(created_by);
CREATE INDEX idx_doctor_interactions_updated_by ON doctor_interactions(updated_by);

CREATE TRIGGER trg_doctor_interactions_updated_at
  BEFORE UPDATE ON doctor_interactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE doctor_interactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY doctor_interactions_tenant_isolation ON doctor_interactions
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
