/**
 * Semelhanca entre dois nomes de pessoa (CRMLAB-58, D-203) — a sugestao de
 * conversa no envio do orcamento do Bitlab. Funcao pura e deterministica, sem
 * dependencia: palavras em comum, sem acento e sem caixa.
 *
 * Nunca decide nada sozinha: so ordena e destaca. Quem vincula e a atendente.
 */

/** Particulas que nao distinguem ninguem ("Maria DA Silva"). */
const IGNORED_TOKENS: ReadonlySet<string> = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);

/** `"MARIA DA SILVA-SOUZA"` -> `["maria", "silva", "souza"]`, sem repetir. */
export function nameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  const plain = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const tokens = plain.split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !IGNORED_TOKENS.has(t));
  return [...new Set(tokens)];
}

/**
 * Palavras em comum / palavras do nome MENOR, de 0 a 1. Nome vazio (ou so
 * particulas) -> 0. `"MARIA DA SILVA SOUZA"` x `"Maria Souza"` = 1;
 * x `"Maria Oliveira"` = 0,5; x `"João"` = 0.
 */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (left.length === 0 || right.length === 0) return 0;
  const other = new Set(right);
  const common = left.filter((t) => other.has(t)).length;
  return common / Math.min(left.length, right.length);
}
