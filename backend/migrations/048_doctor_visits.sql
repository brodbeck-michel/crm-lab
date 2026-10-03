-- =============================================================================
-- 048_doctor_visits.sql
-- CRMLAB-87 (D-256): agenda de visitas a medicos solicitantes — card [B] do
-- epico CRMLAB-85 (Visitacao Medica). SCHEMA.md §36.
--
-- Arquivo UNICO (tabelas + policies), como 047: as tabelas nascem vazias, nao
-- ha backfill. Sem a policy elas VAZARIAM entre laboratorios — o GRANT do
-- `ALTER DEFAULT PRIVILEGES` da 002 ja da acesso a `crm_app` no CREATE TABLE.
--
-- Reagendar muda `scheduled_at` da MESMA visita e grava uma linha em
-- `doctor_visit_reschedules` (resposta 6A do epico): nao ha status "reagendada".
-- =============================================================================

CREATE TABLE doctor_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  doctor_id UUID NOT NULL,
  responsible_user_id UUID,              -- quem visita (usuario do MESMO tenant); NULL so se o usuario for apagado
  scheduled_at TIMESTAMPTZ NOT NULL,     -- data/hora prevista
  type VARCHAR(20) NOT NULL,
  agenda TEXT,                           -- objetivo/pauta
  status VARCHAR(20) NOT NULL DEFAULT 'agendada',
  status_reason VARCHAR(500),            -- motivo de cancelada / nao_recebeu
  status_changed_at TIMESTAMPTZ,
  status_changed_by UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  -- Medico nao se apaga (D-255 item 4: inativa). NO ACTION deixa o CASCADE do tenant passar.
  FOREIGN KEY (doctor_id) REFERENCES doctors(id),
  FOREIGN KEY (responsible_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (status_changed_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (type IN ('presencial', 'online', 'telefone', 'evento')),
  CHECK (status IN ('agendada', 'realizada', 'cancelada', 'nao_recebeu')),
  -- Cancelar e "medico nao recebeu" exigem motivo.
  CHECK (status NOT IN ('cancelada', 'nao_recebeu') OR length(trim(status_reason)) > 0)
);

-- A agenda sempre lista por periodo dentro do tenant.
CREATE INDEX idx_doctor_visits_tenant_scheduled ON doctor_visits(tenant_id, scheduled_at);
-- Indices de FK (D-146): filtros por medico/responsavel e os ON DELETE.
CREATE INDEX idx_doctor_visits_doctor_id ON doctor_visits(doctor_id);
CREATE INDEX idx_doctor_visits_responsible_user_id ON doctor_visits(responsible_user_id);
CREATE INDEX idx_doctor_visits_status_changed_by ON doctor_visits(status_changed_by);
CREATE INDEX idx_doctor_visits_created_by ON doctor_visits(created_by);

CREATE TRIGGER trg_doctor_visits_updated_at
  BEFORE UPDATE ON doctor_visits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE doctor_visits ENABLE ROW LEVEL SECURITY;
CREATE POLICY doctor_visits_tenant_isolation ON doctor_visits
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Historico das mudancas de data/hora. Append-only: o service so insere.
CREATE TABLE doctor_visit_reschedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  visit_id UUID NOT NULL,
  previous_scheduled_at TIMESTAMPTZ NOT NULL,
  new_scheduled_at TIMESTAMPTZ NOT NULL,
  reason VARCHAR(500),
  changed_by UUID,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (visit_id) REFERENCES doctor_visits(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_doctor_visit_reschedules_tenant_id ON doctor_visit_reschedules(tenant_id);
CREATE INDEX idx_doctor_visit_reschedules_visit_id ON doctor_visit_reschedules(visit_id, changed_at);
CREATE INDEX idx_doctor_visit_reschedules_changed_by ON doctor_visit_reschedules(changed_by);

ALTER TABLE doctor_visit_reschedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY doctor_visit_reschedules_tenant_isolation ON doctor_visit_reschedules
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
