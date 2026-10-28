-- =============================================================================
-- 061_name_search_trigram.sql
-- CRMLAB-125 (D-296, D-297): busca por PEDAÇO do nome, sem acento e sem caixa.
-- SCHEMA.md §14 (patients) e §2 (conversations).
--
-- A busca deixou de ser full-text (`to_tsvector @@ plainto_tsquery`, que só
-- casava palavra inteira) e virou, por palavra digitada,
--
--   lower(crm_unaccent(<nome>)) LIKE '%<palavra>%'
--
-- (`NAME_SEARCH_EXPRESSION` em `repositories/name-search.ts`). `crm_unaccent`
-- (043) vem ANTES do `lower`: `lower()` de letra acentuada depende do locale
-- do banco (no `C` ela não muda "Á"); sem acento, tudo é ASCII e o `lower`
-- funciona em qualquer locale.
--
-- ÍNDICE TRIGRAM: `LIKE '%x%'` não usa B-tree; usa GIN com `gin_trgm_ops`
-- (extensão `pg_trgm`). A expressão do índice é a MESMA da consulta — senão o
-- planner não o usa. `crm_unaccent` e `lower` são IMMUTABLE, por isso podem
-- entrar no índice.
--
-- CONDICIONAL (D-297): `pg_trgm` é extensão "trusted" desde o PG 13 — o dono
-- do banco cria sem superusuário — e vem no contrib da imagem
-- `postgres:16-alpine` (prod/hml). O PGlite dos testes a carrega pelo
-- `PgliteDriver`. Mesmo assim, se o `CREATE EXTENSION` falhar num ambiente,
-- a migração NÃO quebra: a busca continua correta, só sem índice (seq scan
-- dentro do tenant). Por isso os dois `DO` abaixo.
--
-- Os índices full-text antigos (`idx_patients_name`, 003, e
-- `idx_conversations_patient_name`, 001) ficam: sem uso pela busca, mas
-- removê-los não é parte deste card (D-297).
--
-- Sem coluna nova, sem tabela nova, sem policy: as duas tabelas já estão sob RLS.
-- =============================================================================

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm indisponivel (%): busca por nome segue sem indice trigram', SQLERRM;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_patients_name_trgm
               ON patients USING GIN (lower(crm_unaccent(name)) gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_conversations_patient_name_trgm
               ON conversations USING GIN (lower(crm_unaccent(patient_name)) gin_trgm_ops)';
  END IF;
END
$$;
