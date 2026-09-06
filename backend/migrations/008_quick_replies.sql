-- =============================================================================
-- 008_quick_replies.sql
-- Respostas rapidas ("macros") do Composer (Onda 8 §3.2, SCHEMA.md §22).
--
-- Arquivo unico (tabela + policy), como a 007: a separacao dos pares 003/004 e
-- 005/006 existe para o backfill rodar antes de a policy ligar, e aqui nao ha
-- backfill — a tabela nasce vazia.
--
-- POR QUE A POLICY NAO E OPCIONAL: o `ALTER DEFAULT PRIVILEGES` de 002 ja
-- concedeu SELECT/INSERT/UPDATE/DELETE a `crm_app` no momento do CREATE TABLE.
-- Tabela nova sem policy nao trava — ela VAZA entre laboratorios (fail-open).
-- =============================================================================

CREATE TABLE quick_replies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Sem a barra: "horariocoleta". A `/` e como se usa, nao o que se grava.
  shortcut   TEXT NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  -- A macro e do laboratorio, nao de quem escreveu: remover a autora nao pode
  -- apagar o texto que a equipe inteira usa todo dia.
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- O CHECK nao e decoracao: `shortcut` e o que a pessoa DIGITA depois da `/`.
  -- Com maiuscula, acento ou espaco, `/Horario Coleta` seria um atalho
  -- impossivel de acertar no teclado e o filtro do menu nunca o acharia.
  CONSTRAINT quick_replies_shortcut_format CHECK (shortcut ~ '^[a-z0-9-]{2,32}$'),
  -- Unicidade DENTRO do tenant: dois laboratorios podem ter `/coleta` com
  -- textos diferentes.
  UNIQUE (tenant_id, shortcut)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON quick_replies TO crm_app;

-- Mesma forma de 002/004/006/007: sem contexto de tenant a comparacao vira
-- NULL — nenhuma linha visivel, nenhum INSERT aceito. Fail-closed.
ALTER TABLE quick_replies ENABLE ROW LEVEL SECURITY;
CREATE POLICY quick_replies_tenant_isolation ON quick_replies
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
