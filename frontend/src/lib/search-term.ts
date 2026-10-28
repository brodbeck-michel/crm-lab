/**
 * Termo das buscas por nome/telefone/CPF (CRMLAB-125, D-296).
 *
 * Só busca a partir de 2 caracteres: com 1 a lista "pisca" com meio
 * laboratório e cada tecla vira uma consulta. Abaixo disso, a tela se
 * comporta como sem busca. O debounce (300 ms) é o da `SearchInput`; o
 * cancelamento do pedido anterior é o `signal` do TanStack Query.
 */
export const SEARCH_MIN_LENGTH = 2;

/** O termo que vai para a API, ou `''` quando ainda é curto demais. */
export function effectiveSearchTerm(raw: string): string {
  const term = raw.trim();
  return term.length >= SEARCH_MIN_LENGTH ? term : '';
}
