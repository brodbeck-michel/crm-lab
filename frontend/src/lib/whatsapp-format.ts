/**
 * Formatação no padrão WhatsApp (CRMLAB-51 / D-183, estendida no CRMLAB-73 / D-242).
 *
 * `parseWhatsApp(text)` devolve uma ÁRVORE — quem desenha (`WhatsAppText`) monta
 * nós React a partir dela. Nunca HTML: o texto do paciente não vira marcação.
 *
 * Ênfase — `*negrito*`, `_itálico_`, `~tachado~`, a regra da D-183 para os três:
 * - abertura não seguida de espaço, fechamento não precedido de espaço;
 * - não atravessa quebra de linha nem contém o mesmo símbolo;
 * - o símbolo fica na borda da palavra: colado por fora a letra/dígito (ou ao
 *   mesmo símbolo) não formata (`2*3*4`, `snake_case_var`). Símbolos
 *   DIFERENTES aninham: `_*texto*_` é negrito dentro de itálico.
 *
 * Literais (nada formata dentro): ```` ```mono``` ```` (pode atravessar
 * linhas), `` `código` `` (uma linha) e links `http(s)://` / `www.` — por isso
 * o `_` de `https://site.com/a_b` não vira itálico.
 *
 * Linha: `> ` citação, `- `/`* ` item de lista, `1. ` item numerado.
 */

export type Emphasis = 'bold' | 'italic' | 'strike';

export type WhatsAppNode =
  | { type: 'text'; text: string }
  | { type: Emphasis; children: WhatsAppNode[] }
  | { type: 'mono'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; text: string };

export type LineKind = 'plain' | 'quote' | 'bullet' | 'numbered';

export interface WhatsAppLine {
  kind: LineKind;
  /** Só em `numbered`: o número como foi escrito (`"1"`, `"12"`). */
  marker?: string;
  children: WhatsAppNode[];
}

const MARKERS: Record<string, Emphasis> = { '*': 'bold', _: 'italic', '~': 'strike' };

interface Literal {
  start: number;
  end: number;
  node: WhatsAppNode;
}

const MONO = /```([\s\S]+?)```/g;
const CODE = /`([^`\n]+)`/g;
/** Até o primeiro espaço (ou `<`/`>`); o começo não pode estar colado em letra/ponto. */
const URL = /(?<![\p{L}\p{N}@./])(?:https?:\/\/|www\.)[^\s<>]+/giu;
/** Pontuação que termina a frase, não o link (`veja www.x.com.`). */
const TRAILING = /[.,;:!?'"*_~]$/;

function overlaps(literals: Literal[], start: number, end: number): boolean {
  return literals.some((literal) => start < literal.end && end > literal.start);
}

/** Tira do fim do link a pontuação da frase e o `)` que não tem par dentro dele. */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    if (TRAILING.test(url)) {
      url = url.slice(0, -1);
      continue;
    }
    if (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

/** Troca cada literal por espaços do mesmo tamanho (os índices continuam valendo). */
function mask(text: string, literals: Literal[]): string {
  let out = text;
  for (const literal of literals) {
    out = out.slice(0, literal.start) + ' '.repeat(literal.end - literal.start) + out.slice(literal.end);
  }
  return out;
}

/** Mono primeiro, depois `código`, depois links — nenhum atravessa o anterior. */
function findLiterals(text: string): Literal[] {
  const literals: Literal[] = [];
  for (const match of text.matchAll(MONO)) {
    const start = match.index ?? 0;
    literals.push({
      start,
      end: start + match[0].length,
      node: { type: 'mono', text: match[1] ?? '' },
    });
  }
  // Cada etapa procura num texto com os literais anteriores apagados: senão a crase
  // do fim de um ```mono``` casaria com a do `código` seguinte e o engoliria.
  let masked = mask(text, literals);
  for (const match of masked.matchAll(CODE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (overlaps(literals, start, end)) continue;
    literals.push({ start, end, node: { type: 'code', text: match[1] ?? '' } });
  }
  const links: Literal[] = [];
  masked = mask(text, literals);
  for (const match of masked.matchAll(URL)) {
    const start = match.index ?? 0;
    const url = trimUrl(match[0]);
    // `www.` sozinho (ou `https://` sem host) não é link.
    if (!/^(?:https?:\/\/|www\.)[^./]/i.test(url)) continue;
    const end = start + url.length;
    if (overlaps(literals, start, end)) continue;
    const href = /^www\./i.test(url) ? `https://${url}` : url;
    links.push({ start, end, node: { type: 'link', href, text: url } });
  }
  return [...literals, ...links].sort((a, b) => a.start - b.start);
}

const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

class InlineParser {
  private readonly literalAt = new Map<number, Literal>();

  constructor(
    private readonly text: string,
    literals: Literal[],
  ) {
    for (const literal of literals) this.literalAt.set(literal.start, literal);
  }

  private isOpener(index: number, marker: string): boolean {
    const before = index > 0 ? this.text.charAt(index - 1) : '';
    const after = this.text.charAt(index + 1);
    if (before !== '' && (WORD.test(before) || before === marker)) return false;
    return after !== '' && !SPACE.test(after) && after !== marker;
  }

  private isCloser(index: number, marker: string): boolean {
    const before = this.text.charAt(index - 1);
    const after = this.text.charAt(index + 1);
    if (SPACE.test(before)) return false;
    return after === '' || (!WORD.test(after) && after !== marker);
  }

  /** O próximo `marker` fora de literal, na mesma linha, tem que fechar — senão não há par. */
  private findCloser(open: number, end: number, marker: string): number {
    let index = open + 1;
    while (index < end) {
      const literal = this.literalAt.get(index);
      if (literal) {
        if (literal.end > end) return -1;
        index = literal.end;
        continue;
      }
      const char = this.text.charAt(index);
      if (char === '\n') return -1;
      if (char === marker) return this.isCloser(index, marker) ? index : -1;
      index++;
    }
    return -1;
  }

  parse(start: number, end: number): WhatsAppNode[] {
    const nodes: WhatsAppNode[] = [];
    let textStart = start;
    const flush = (upTo: number) => {
      if (upTo > textStart) nodes.push({ type: 'text', text: this.text.slice(textStart, upTo) });
    };
    let index = start;
    while (index < end) {
      const literal = this.literalAt.get(index);
      if (literal && literal.end <= end) {
        flush(index);
        nodes.push(literal.node);
        index = literal.end;
        textStart = index;
        continue;
      }
      const char = this.text.charAt(index);
      const emphasis = MARKERS[char];
      if (emphasis && this.isOpener(index, char)) {
        const close = this.findCloser(index, end, char);
        if (close > index + 1) {
          flush(index);
          nodes.push({ type: emphasis, children: this.parse(index + 1, close) });
          index = close + 1;
          textStart = index;
          continue;
        }
      }
      index++;
    }
    flush(end);
    return nodes;
  }
}

const LINE_PREFIX: ReadonlyArray<{ kind: LineKind; pattern: RegExp }> = [
  { kind: 'quote', pattern: /^> / },
  { kind: 'bullet', pattern: /^[-*] / },
  { kind: 'numbered', pattern: /^(\d{1,3})\. / },
];

export function parseWhatsApp(text: string): WhatsAppLine[] {
  const literals = findLiterals(text);
  const parser = new InlineParser(text, literals);

  // Linhas "lógicas": uma quebra dentro de ```mono``` não abre linha nova.
  const breaks: number[] = [];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    if (!literals.some((literal) => index > literal.start && index < literal.end)) breaks.push(index);
  }

  const lines: WhatsAppLine[] = [];
  let lineStart = 0;
  for (const lineEnd of [...breaks, text.length]) {
    const raw = text.slice(lineStart, lineEnd);
    let kind: LineKind = 'plain';
    let marker: string | undefined;
    let contentStart = lineStart;
    for (const prefix of LINE_PREFIX) {
      const match = prefix.pattern.exec(raw);
      if (!match) continue;
      kind = prefix.kind;
      marker = match[1];
      contentStart = lineStart + match[0].length;
      break;
    }
    const line: WhatsAppLine = { kind, children: parser.parse(contentStart, lineEnd) };
    if (marker !== undefined) line.marker = marker;
    lines.push(line);
    lineStart = lineEnd + 1;
  }
  return lines;
}

/** Texto visível de uma árvore (sem os símbolos) — útil para teste e acessibilidade. */
export function plainText(nodes: WhatsAppNode[]): string {
  return nodes
    .map((node) => ('children' in node ? plainText(node.children) : node.text))
    .join('');
}
