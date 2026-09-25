/**
 * Negrito no padrão WhatsApp (CRMLAB-51, D-183): `*texto*`.
 *
 * - abertura não seguida de espaço, fechamento não precedido de espaço;
 * - não atravessa quebra de linha nem contém outro `*` (`**` vazio não casa);
 * - o `*` fica na borda da palavra: colado por fora a letra/dígito não formata
 *   (`2*3*4`, `a*b*c`), igual ao WhatsApp.
 *
 * Devolve segmentos para quem renderiza montar nós React — nunca HTML.
 */
export interface TextSegment {
  text: string;
  bold: boolean;
}

const BOLD = /(?<![\p{L}\p{N}_*])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?![\p{L}\p{N}_*])/gu;

export function splitBold(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(BOLD)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ text: text.slice(last, start), bold: false });
    segments.push({ text: match[1] ?? '', bold: true });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), bold: false });
  return segments;
}
