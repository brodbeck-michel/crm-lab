-- =============================================================================
-- 050_doctor_visit_record.sql
-- CRMLAB-88 (D-258): registro da visita — check-in/out, relato, proximo passo e
-- anexos. Card [C] do epico CRMLAB-85 (Visitacao Medica). SCHEMA.md §37.
--
-- Arquivo UNICO (colunas + tabela + policy), como 047/048: a tabela nova nasce
-- vazia e as colunas novas ficam NULL nas visitas que ja existem. Nenhuma
-- visita e `realizada` hoje (a 048 nao tinha rota que gravasse esse status),
-- entao o CHECK de "realizada exige check-out" nao quebra dado existente.
-- =============================================================================

ALTER TABLE doctor_visits
  ADD COLUMN check_in_at TIMESTAMPTZ,        -- "Cheguei" (hora do servidor)
  ADD COLUMN check_in_by UUID,
  ADD COLUMN check_out_at TIMESTAMPTZ,       -- "Sai" -> status realizada
  ADD COLUMN check_out_by UUID,
  ADD COLUMN report_presented TEXT,          -- o que foi apresentado
  ADD COLUMN report_feedback TEXT,           -- feedback do medico
  ADD COLUMN report_objections TEXT,         -- objecoes
  ADD COLUMN next_visit_date DATE;           -- proximo passo: data de retorno (so sugere)

ALTER TABLE doctor_visits
  ADD CONSTRAINT doctor_visits_check_in_by_fkey
    FOREIGN KEY (check_in_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT doctor_visits_check_out_by_fkey
    FOREIGN KEY (check_out_by) REFERENCES users(id) ON DELETE SET NULL,
  -- Check-out exige check-in e nao vem antes dele.
  ADD CONSTRAINT doctor_visits_check_out_after_in
    CHECK (check_out_at IS NULL OR (check_in_at IS NOT NULL AND check_out_at >= check_in_at)),
  -- `realizada` so nasce do check-out.
  ADD CONSTRAINT doctor_visits_realizada_has_check_out
    CHECK (status <> 'realizada' OR check_out_at IS NOT NULL);

-- Indices de FK (D-146).
CREATE INDEX idx_doctor_visits_check_in_by ON doctor_visits(check_in_by);
CREATE INDEX idx_doctor_visits_check_out_by ON doctor_visits(check_out_by);

-- Anexos da visita (imagem e PDF). O arquivo mora em MEDIA_DIR com o `id` da
-- linha como nome (lib/media-storage.ts) — NUNCA o `file_name` do usuario.
CREATE TABLE doctor_visit_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  visit_id UUID NOT NULL,
  mime_type VARCHAR(100) NOT NULL,           -- ja passado pela allow-list + sniff
  file_name VARCHAR(255) NOT NULL,
  byte_size INTEGER NOT NULL,
  uploaded_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (visit_id) REFERENCES doctor_visits(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (byte_size > 0)
);

CREATE INDEX idx_doctor_visit_attachments_tenant_id ON doctor_visit_attachments(tenant_id);
CREATE INDEX idx_doctor_visit_attachments_visit_id ON doctor_visit_attachments(visit_id, created_at);
CREATE INDEX idx_doctor_visit_attachments_uploaded_by ON doctor_visit_attachments(uploaded_by);

ALTER TABLE doctor_visit_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY doctor_visit_attachments_tenant_isolation ON doctor_visit_attachments
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
