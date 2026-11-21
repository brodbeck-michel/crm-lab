-- =============================================================================
-- 069_scans.sql
-- CRMLAB-184 (D-327): Digitalizar pelo celular. SCHEMA.md §50.
--
-- `capture_devices`: o celular pareado (credencial e codigo de pareamento so
-- em hash sha256). `scans`: a fila "Digitalizacoes" do laboratorio (foto vive
-- 2 dias; o arquivo fica em MEDIA_DIR/scans/<id>).
--
-- Arquivo UNICO (tabelas + policies), como 056: as tabelas nascem vazias, nao
-- ha backfill. Sem a policy elas VAZARIAM entre laboratorios — o GRANT do
-- `ALTER DEFAULT PRIVILEGES` da 002 ja da acesso a `crm_app` no CREATE TABLE.
-- =============================================================================

CREATE TABLE capture_devices (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                    VARCHAR(60) NOT NULL,
  -- sha256 hex da credencial; NULL = nao pareado ou revogado.
  token_hash              CHAR(64),
  -- sha256 hex do codigo; NULL = sem codigo valido.
  pairing_code_hash       CHAR(64),
  pairing_code_expires_at TIMESTAMPTZ,
  paired_at               TIMESTAMPTZ,
  last_used_at            TIMESTAMPTZ,
  -- Revogado nao volta: cadastra outro.
  revoked_at              TIMESTAMPTZ,
  created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_capture_devices_token_hash
  ON capture_devices(token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX uq_capture_devices_pairing_code_hash
  ON capture_devices(pairing_code_hash) WHERE pairing_code_hash IS NOT NULL;
CREATE INDEX idx_capture_devices_tenant_id ON capture_devices(tenant_id);
-- Indice de FK (D-146): o ON DELETE SET NULL.
CREATE INDEX idx_capture_devices_created_by ON capture_devices(created_by);

CREATE TABLE scans (
  -- Tambem o nome do arquivo em disco.
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id   UUID NOT NULL REFERENCES capture_devices(id) ON DELETE CASCADE,
  -- Ja passado pela allow-list + sniff + JPEG (D-290).
  mime_type   VARCHAR(127) NOT NULL,
  byte_size   INTEGER NOT NULL CHECK (byte_size > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- created_at + 2 dias (D-327 item 6).
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_scans_tenant_created ON scans(tenant_id, created_at DESC);
CREATE INDEX idx_scans_device_id ON scans(device_id);
CREATE INDEX idx_scans_expires_at ON scans(expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON capture_devices TO crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON scans TO crm_app;

ALTER TABLE capture_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY capture_devices_tenant_isolation ON capture_devices
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE scans ENABLE ROW LEVEL SECURITY;
CREATE POLICY scans_tenant_isolation ON scans
  FOR ALL
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
