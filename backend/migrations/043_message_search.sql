-- =============================================================================
-- 043_message_search.sql
-- Busca pelo conteúdo das mensagens (CRMLAB-68, D-228 — SCHEMA.md §4).
--
-- SEM EXTENSÃO `unaccent`: `CREATE EXTENSION` pede superusuário no Postgres
-- gerenciado e não existe no PGlite dos testes. `crm_unaccent` troca as letras
-- acentuadas do português por `translate()` e é IMMUTABLE — por isso pode
-- entrar na expressão de um índice. Maiúscula/minúscula quem resolve é o
-- `to_tsvector`.
--
-- ÍNDICE PARCIAL: mensagem apagada pelo remetente (D-220) nunca pode ser achada,
-- então nem entra no índice. A consulta (`MESSAGE_SEARCH_EXPRESSION` em
-- `message.repository.ts`) repete a expressão E o predicado literalmente —
-- diferente disso, o planner não usa o índice.
--
-- Sem coluna nova, sem tabela nova, sem policy: `messages` já está sob RLS (002).
-- =============================================================================

CREATE OR REPLACE FUNCTION crm_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$
    SELECT translate(
      $1,
      'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ',
      'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN'
    )
  $$;

CREATE INDEX IF NOT EXISTS idx_messages_content_search
  ON messages USING GIN (to_tsvector('portuguese', crm_unaccent(content)))
  WHERE deleted_at IS NULL;
