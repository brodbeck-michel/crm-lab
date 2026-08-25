-- =============================================================================
-- 003_patients_and_channels.sql
-- Onda 6 — paciente como entidade propria, canal por laboratorio, configuracao
-- operacional e estado de leitura do chat interno.
--
-- Fonte: docs/database/SCHEMA.md §14 a §17 · docs/DECISIONS.md D-059, D-063,
--        D-064, D-065, D-068, D-071.
--
-- Conteudo:
--   1. tabela patients                       (SCHEMA §14 / D-059)
--   2. tabela tenant_channels                (SCHEMA §15 / D-064)
--   3. tabela tenant_settings                (SCHEMA §16 / D-065)
--   4. tabela channel_reads                  (SCHEMA §17 / D-068)
--   5. conversations.patient_id + FK + indice (D-059)
--   6. proposal_items.position               (D-071)
--   7. BACKFILL de patients / conversations.patient_id / proposal_items.position
--
-- O RLS das quatro tabelas novas fica na 004_rls_onda6.sql, de proposito: o
-- backfill abaixo escreve linhas de TODOS os tenants de uma vez (como o seed) e
-- rodaria contra as proprias policies fail-closed se elas ja existissem.
--
-- Este arquivo e aplicado INTEIRO dentro de uma transacao pelo runner
-- (src/db/migrator.ts). Nao contem meta-comandos do psql.
-- =============================================================================

-- =============================================================================
-- 1. patients — cadastro do paciente (SCHEMA.md §14, D-059)
--
-- `phone` e a identidade do paciente DENTRO do tenant: dois laboratorios podem
-- ter o mesmo telefone e sao pacientes distintos. UNIQUE (tenant_id, phone) e o
-- que faz `findOrCreateByPhone` deduplicar sob concorrencia (ON CONFLICT).
--
-- Nao ha DELETE: propostas historicas apontam para conversas que apontam para o
-- paciente. O caminho LGPD e `anonymized_at` (D-063), que preserva NOT NULL e a
-- unicidade trocando o telefone por 'anon-' || substring(id::text, 1, 8).
-- =============================================================================
CREATE TABLE patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  phone VARCHAR(20) NOT NULL,
  name VARCHAR(255),
  email VARCHAR(255),
  birth_date DATE,
  document VARCHAR(14),                      -- CPF, so digitos
  notes TEXT,                                -- interno (BUSINESS_RULES §7)
  tags JSONB NOT NULL DEFAULT '[]',
  custom_fields JSONB NOT NULL DEFAULT '{}',
  anonymized_at TIMESTAMP,                   -- LGPD (D-063)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, phone)
);

CREATE INDEX idx_patients_tenant_id ON patients(tenant_id);
CREATE INDEX idx_patients_document ON patients(tenant_id, document);

-- Mesma expressao EXATA de idx_conversations_patient_name (001): expressao
-- diferente = indice nao usado pela busca.
CREATE INDEX idx_patients_name
  ON patients USING GIN (to_tsvector('portuguese', COALESCE(name, '')));

CREATE TRIGGER trg_patients_updated_at
  BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 2. tenant_channels — conexao de canal por laboratorio (SCHEMA.md §15, D-064)
--
-- `api_token` e `webhook_secret` sao SEGREDOS write-only: nunca saem em
-- resposta de API, log ou audit log. O repositorio projeta colunas
-- explicitamente — `SELECT *` devolvido ao controller e bug de seguranca.
-- =============================================================================
CREATE TABLE tenant_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  channel VARCHAR(50) NOT NULL,
  display_name VARCHAR(255),
  phone_number_id VARCHAR(255),
  phone_number VARCHAR(30),
  api_token TEXT,
  webhook_secret TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  connected_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, channel),
  CHECK (channel IN ('whatsapp', 'sms', 'web', 'direct'))
);

CREATE INDEX idx_tenant_channels_tenant_id ON tenant_channels(tenant_id);

CREATE TRIGGER trg_tenant_channels_updated_at
  BEFORE UPDATE ON tenant_channels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 3. tenant_settings — configuracao operacional (SCHEMA.md §16, D-065)
--
-- 1:1 com tenants, `tenant_id` como PK E chave da policy padrao.
-- LINHA AUSENTE = DEFAULTS: o GET responde os defaults sem gravar; o primeiro
-- PATCH faz INSERT ... ON CONFLICT (tenant_id) DO UPDATE. Por isso esta
-- migracao NAO cria uma linha por tenant existente.
-- =============================================================================
CREATE TABLE tenant_settings (
  tenant_id UUID PRIMARY KEY,
  distribution_mode VARCHAR(20) NOT NULL DEFAULT 'manual',
  greeting_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  greeting_message TEXT,
  offhours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  offhours_message TEXT,
  business_hours JSONB NOT NULL DEFAULT '{"timezone":"America/Sao_Paulo","days":{}}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CHECK (distribution_mode IN ('manual', 'round_robin'))
);

CREATE TRIGGER trg_tenant_settings_updated_at
  BEFORE UPDATE ON tenant_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 4. channel_reads — estado de leitura do chat interno (SCHEMA.md §17, D-068)
--
-- Ausencia de linha = usuario nunca abriu o canal (lastReadAt: null e
-- unreadCount conta tudo que nao e dele). `unreadCount` continua DERIVADO,
-- nunca materializado (BUSINESS_RULES §5) — nao existe coluna de contador aqui.
--
-- `tenant_id` e redundante com o canal e obrigatorio pelo mesmo motivo de
-- proposal_items (D-002 + AGENTS.md Contrato 2): sem ele a policy precisaria de
-- um EXISTS no canal a cada linha lida.
-- =============================================================================
CREATE TABLE channel_reads (
  tenant_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  user_id UUID NOT NULL,
  last_read_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES internal_channels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_channel_reads_tenant_id ON channel_reads(tenant_id);
CREATE INDEX idx_channel_reads_user ON channel_reads(user_id);

CREATE TRIGGER trg_channel_reads_updated_at
  BEFORE UPDATE ON channel_reads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 5. conversations.patient_id (D-059)
--
-- NULLABLE de proposito: linha anterior ao backfill (replica antiga) e legitima,
-- a ficha simplesmente nao a lista. ON DELETE SET NULL porque nao existe DELETE
-- de paciente no produto — a clausula existe para nao deixar FK orfa caso o
-- tenant seja removido em cascata em outra ordem.
--
-- As colunas patient_name / patient_phone / patient_email PERMANECEM (passo 1
-- da regra dos 3 passos de AGENTS.md). Nenhum contrato de /conversations muda.
-- =============================================================================
ALTER TABLE conversations ADD COLUMN patient_id UUID;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_patient_id_fkey
  FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE SET NULL;

CREATE INDEX idx_conversations_patient_id ON conversations(patient_id);

-- =============================================================================
-- 6. proposal_items.position (D-071)
--
-- Ordem em que o atendente montou o orcamento. DEFAULT 0 mantem a migracao
-- compativel com o dado existente; toda leitura ordena por
-- `position ASC, created_at ASC`.
-- =============================================================================
ALTER TABLE proposal_items ADD COLUMN "position" INT NOT NULL DEFAULT 0;

CREATE INDEX idx_proposal_items_proposal_position
  ON proposal_items(proposal_id, "position");

-- =============================================================================
-- 7. BACKFILL
--
-- Roda com as tabelas novas ainda SEM RLS (as policies entram na 004): escreve
-- linhas de todos os tenants de uma vez, como o seed faz.
--
-- Idempotente por construcao:
--   - patients: ON CONFLICT (tenant_id, phone) DO NOTHING
--   - conversations.patient_id: so atualiza o que ainda nao aponta para a linha
--   - proposal_items.position: so atualiza o que difere da ordem calculada
-- Rodar de novo (ou rodar sobre base ja migrada) nao duplica nem reescreve nada.
-- =============================================================================

-- 7a. Um paciente por (tenant_id, patient_phone) distinto das conversas.
--     Nome e e-mail vem do valor NAO NULO mais recente daquele telefone
--     (ORDER BY last_message_at DESC NULLS LAST, created_at DESC) — os dois
--     campos sao escolhidos INDEPENDENTEMENTE, entao uma conversa recente sem
--     e-mail nao apaga o e-mail que a conversa anterior conhecia.
--     `created_at` do paciente = a conversa mais antiga daquele telefone.
INSERT INTO patients (tenant_id, phone, name, email, created_at, updated_at)
SELECT
  c.tenant_id,
  c.patient_phone,
  (ARRAY_AGG(c.patient_name ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC)
     FILTER (WHERE c.patient_name IS NOT NULL))[1],
  (ARRAY_AGG(c.patient_email ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC)
     FILTER (WHERE c.patient_email IS NOT NULL))[1],
  MIN(c.created_at),
  MIN(c.created_at)
FROM conversations c
WHERE c.patient_phone IS NOT NULL
  AND btrim(c.patient_phone) <> ''
GROUP BY c.tenant_id, c.patient_phone
ON CONFLICT (tenant_id, phone) DO NOTHING;

-- 7b. Religa cada conversa ao seu paciente.
--
--     O trigger de updated_at e desligado durante o UPDATE: sem isso, TODA
--     conversa da base teria `updated_at` saltando para o instante da migracao,
--     e "atualizada ha 4 minutos" passaria a mentir na tela inteira. O backfill
--     nao e uma edicao do usuario.
ALTER TABLE conversations DISABLE TRIGGER trg_conversations_updated_at;

UPDATE conversations c
   SET patient_id = p.id
  FROM patients p
 WHERE p.tenant_id = c.tenant_id
   AND p.phone = c.patient_phone
   AND c.patient_id IS DISTINCT FROM p.id;

ALTER TABLE conversations ENABLE TRIGGER trg_conversations_updated_at;

-- 7c. Ordem atual dos itens vira `position`, para nao embaralhar propostas ja
--     existentes. Desempate por `id` (estavel) quando dois itens compartilham o
--     mesmo `created_at`.
WITH ordered AS (
  SELECT id,
         (ROW_NUMBER() OVER (PARTITION BY proposal_id ORDER BY created_at ASC, id ASC) - 1)::int
           AS pos
    FROM proposal_items
)
UPDATE proposal_items pi
   SET "position" = o.pos
  FROM ordered o
 WHERE o.id = pi.id
   AND pi."position" IS DISTINCT FROM o.pos;
