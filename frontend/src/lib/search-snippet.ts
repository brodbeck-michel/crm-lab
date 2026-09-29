/**
 * Trecho e destaque da busca nas mensagens (CRMLAB-68, D-228 item 6).
 *
 * A API devolve o `content` inteiro; quem recorta o trecho e marca o termo é a
 * tela. A comparação é SEM acento e SEM caixa, como a do servidor: quem digitou
 * "orcamento" vê "orçamento" destacado. Funções puras — o componente só troca
 * as partes `match` por `<mark>`; nada de HTML montado aqui.
 */

/** Uma letra/dígito sem acento e minúscula (pode virar mais de um caractere). */
function foldChar(char: string): string {
  return char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Texto dobrado + de onde veio cada caractere dobrado no original. */
function fold(text: string): { folded: string; origin: number[] } {
  let folded = '';
  const origin: number[] = [];
  let index = 0;
  for (const char of text) {
    const piece = foldChar(char);
    for (let i = 0; i < piece.length; i += 1) origin.push(index);
    folded += piece;
    index += char.length;
  }
  origin.push(index);
  return { folded, origin };
}

/** Palavras do termo, como o servidor as enxerga (só letras e dígitos). */
export function searchWords(term: string): string[] {
  return term
    .split(/[^\p{L}\p{N}]+/u)
    .map(foldChar)
    .filter((word) => word.length > 0);
}

/** O termo tem o mínimo que o servidor aceita (2 letras ou dígitos). */
export function isSearchableTerm(term: string): boolean {
  return (term.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2;
}

interface Range {
  start: number;
  end: number;
}

/** Ocorrências de qualquer palavra do termo, em posições do texto ORIGINAL. */
function matchRanges(text: string, words: string[]): Range[] {
  if (words.length === 0) return [];
  const { folded, origin } = fold(text);
  const ranges: Range[] = [];
  for (const word of words) {
    let from = folded.indexOf(word);
    while (from !== -1) {
      ranges.push({ start: origin[from] ?? 0, end: origin[from + word.length] ?? text.length });
      from = folded.indexOf(word, from + word.length);
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  // Junta sobreposição ("glic" e "glicose" no mesmo lugar).
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export interface HighlightPart {
  text: string;
  match: boolean;
}

/** Texto em partes, com as ocorrências do termo marcadas. */
export function highlightParts(text: string, term: string): HighlightPart[] {
  const ranges = matchRanges(text, searchWords(term));
  const parts: HighlightPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push({ text: text.slice(cursor, range.start), match: false });
    parts.push({ text: text.slice(range.start, range.end), match: true });
    cursor = range.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts;
}

/** Caracteres de contexto antes da primeira ocorrência. */
export const SNIPPET_LEAD = 30;
/** Tamanho máximo do trecho (sem contar as reticências). */
export const SNIPPET_MAX = 120;

/**
 * Trecho em volta da primeira ocorrência: uma linha, espaços colapsados,
 * "…" onde cortou. Sem ocorrência (o servidor casa por radical, a tela por
 * substring), o começo do texto.
 */
export function searchSnippet(content: string, term: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  const first = matchRanges(text, searchWords(term))[0];
  let start = first ? Math.max(0, first.start - SNIPPET_LEAD) : 0;
  // Não começa no meio de uma palavra.
  if (start > 0) {
    const space = text.lastIndexOf(' ', start);
    start = space >= 0 && first && first.start - space <= SNIPPET_LEAD * 2 ? space + 1 : start;
  }
  const end = Math.min(text.length, start + SNIPPET_MAX);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
