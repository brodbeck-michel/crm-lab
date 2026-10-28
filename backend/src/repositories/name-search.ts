/**
 * Busca por PEDAÇO do nome (CRMLAB-125, D-296) — usada por `patients.name`
 * (tela de Pacientes, busca de paciente do Atendimento, Nova conversa) e por
 * `conversations.patient_name` (lista do Atendimento).
 *
 * Cada palavra digitada vira `lower(crm_unaccent(<coluna>)) LIKE '%palavra%'`
 * e TODAS precisam casar (AND), em qualquer ordem: "mar sil" e "silva maria"
 * acham "Maria da Silva". Maiúscula e acento não importam ("JOAO" acha
 * "João"). A palavra é dobrada aqui, no JS, do mesmo jeito que `crm_unaccent`
 * + `lower` dobram a coluna no banco.
 *
 * A expressão da coluna é a MESMA dos índices trigram da migração 061 —
 * diferente dela, o planner não usa o índice. Plano esperado com o índice
 * (tabela grande): `Bitmap Heap Scan on patients` ← `Bitmap Index Scan on
 * idx_patients_name_trgm` (um `BitmapAnd` dos termos), com o filtro de
 * `tenant_id` do RLS como `Filter`. Termo de 1–2 letras não gera trigrama
 * útil: o planner tende a seq scan, e o frontend só busca a partir de 2.
 *
 * Funções puras: quem monta o SQL passa um `addParam` que devolve o `$n`.
 */

/** No máximo isto de palavras entra no filtro — o resto é ignorado. */
export const MAX_NAME_SEARCH_WORDS = 6;

/** A coluna como o índice da 061 a guarda (sem acento, minúscula). */
export function nameSearchExpression(column: string): string {
  return `lower(crm_unaccent(${column}))`;
}

/** Sem acento e minúscula — o espelho de `lower(crm_unaccent(x))`. */
export function foldName(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** `%`, `_` e `\` digitados são literais no LIKE (escape padrão: `\`). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** As palavras do termo, já dobradas e sem vazias. */
export function nameSearchWords(search: string): string[] {
  return foldName(search)
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, MAX_NAME_SEARCH_WORDS);
}

/**
 * Condição do WHERE (AND das palavras), ou `null` sem palavra nenhuma.
 * Combine com `OR` de telefone/CPF por fora.
 */
export function nameSearchWhere(
  column: string,
  search: string,
  addParam: (value: unknown) => string,
): string | null {
  const words = nameSearchWords(search);
  if (words.length === 0) return null;
  const expr = nameSearchExpression(column);
  const clauses = words.map((word) => `${expr} LIKE ${addParam(`%${escapeLike(word)}%`)}`);
  return `(${clauses.join(' AND ')})`;
}

/**
 * Relevância para o ORDER BY (menor = antes): 0 = o nome COMEÇA pela 1ª
 * palavra; 1 = outra palavra do nome começa por ela; 2 = só contém (ou casou
 * por telefone/CPF). `null` sem palavra. Parâmetros PRÓPRIOS: entre só na
 * query que ordena — parâmetro não referenciado quebra o `COUNT`.
 */
export function nameSearchRank(
  column: string,
  search: string,
  addParam: (value: unknown) => string,
): string | null {
  const first = nameSearchWords(search)[0];
  if (first === undefined) return null;
  const expr = nameSearchExpression(column);
  const escaped = escapeLike(first);
  return (
    `(CASE WHEN ${expr} LIKE ${addParam(`${escaped}%`)} THEN 0` +
    ` WHEN ${expr} LIKE ${addParam(`% ${escaped}%`)} THEN 1 ELSE 2 END)`
  );
}
