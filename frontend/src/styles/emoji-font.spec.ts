import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CRMLAB-111 / D-285: emoji igual em todo SO com a Noto Color Emoji
 * auto-hospedada. Guarda três coisas que quebrariam em silêncio:
 *   1. toda pilha de fonte (`--font-heading`/`--font-body`, inclusive as de
 *      `data-font`) tem `var(--font-emoji)` DEPOIS das fontes de texto e ANTES
 *      da genérica — se viesse antes, dígitos/#/* virariam glifo da Noto;
 *   2. o @font-face é recortado por `unicode-range` e aponta para woff2 locais
 *      que existem (sem CDN — CSP `font-src 'self'`);
 *   3. o CSS da fonte é importado no bootstrap, antes dos tokens;
 *   4. os woff2 são COLRv1 (tabela COLR), não OpenType-SVG — Chrome/Edge não
 *      desenham SVG e o emoji sai em branco (achado na validação da hml).
 */
const root = process.cwd();
const tokens = readFileSync(resolve(root, 'src/styles/tokens.css'), 'utf8');
const fontDir = resolve(root, 'src/assets/fonts/noto-color-emoji');
const fontCss = readFileSync(resolve(fontDir, 'noto-color-emoji.css'), 'utf8');
const GENERIC = ['sans-serif', 'serif'];

function stacks(): { name: string; families: string[] }[] {
  const found: { name: string; families: string[] }[] = [];
  for (const match of tokens.matchAll(/(--font-(?:heading|body)):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) found.push({ name, families: value.split(',').map((part) => part.trim()) });
  }
  return found;
}

// Tags da tabela de "tags conhecidas" do WOFF2 (índice = 6 bits baixos da flag).
const WOFF2_KNOWN_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix'];

function woff2Tables(file: string): string[] {
  const data = readFileSync(file);
  let offset = 48; // cabeçalho WOFF2
  const readBase128 = (): void => {
    while ((data[offset++] ?? 0) & 0x80);
  };
  const tags: string[] = [];
  for (let i = data.readUInt16BE(12); i > 0; i--) {
    const flags = data[offset++] ?? 0;
    let tag: string;
    if ((flags & 63) === 63) {
      tag = data.toString('latin1', offset, offset + 4);
      offset += 4;
    } else {
      tag = WOFF2_KNOWN_TAGS[flags & 63] ?? '?';
    }
    readBase128(); // origLength
    const transform = (flags >> 6) & 3;
    const glyfOrLoca = tag === 'glyf' || tag === 'loca';
    if ((glyfOrLoca && transform === 0) || (!glyfOrLoca && transform !== 0)) readBase128(); // transformLength
    tags.push(tag);
  }
  return tags;
}

describe('fonte de emoji (D-285)', () => {
  it('o token --font-emoji é a Noto Color Emoji', () => {
    expect(tokens).toMatch(/--font-emoji:\s*'Noto Color Emoji';/);
  });

  it('toda pilha tem var(--font-emoji) entre as fontes de texto e a genérica', () => {
    const all = stacks();
    expect(all.length).toBe(8); // :root + 3 data-font, heading e body em cada
    for (const { name, families } of all) {
      const emoji = families.indexOf('var(--font-emoji)');
      expect(emoji, `${name}: ${families.join(', ')}`).toBeGreaterThan(0);
      expect(GENERIC).toContain(families[families.length - 1]);
      expect(emoji, `${name}: emoji tem de ser a penúltima`).toBe(families.length - 2);
    }
  });

  it('@font-face recortado por unicode-range, só woff2 locais que existem', () => {
    const faces = fontCss.match(/@font-face\s*{[^}]*}/g) ?? [];
    expect(faces.length).toBe(11);
    for (const face of faces) {
      expect(face).toContain("font-family: 'Noto Color Emoji'");
      expect(face).toMatch(/unicode-range:\s*U\+/);
      const url = /src: url\(\.\/([^)]+\.woff2)\) format\('woff2'\) tech\(color-COLRv1\);/.exec(face)?.[1];
      expect(url, face).toBeDefined();
      expect(existsSync(resolve(fontDir, url ?? ''))).toBe(true);
    }
    expect(fontCss).not.toMatch(/https?:\/\//);
    expect(existsSync(resolve(fontDir, 'OFL.txt'))).toBe(true);
  });

  it('todo woff2 é COLRv1 (COLR + CPAL), sem OpenType-SVG', () => {
    const files = readdirSync(fontDir).filter((name) => name.endsWith('.woff2'));
    expect(files.length).toBe(11);
    for (const name of files) {
      const tables = woff2Tables(resolve(fontDir, name));
      expect(tables, name).toContain('COLR');
      expect(tables, name).toContain('CPAL');
      expect(tables, name).not.toContain('SVG ');
    }
  });

  it('main.tsx importa o CSS da fonte', () => {
    const main = readFileSync(resolve(root, 'src/main.tsx'), 'utf8');
    expect(main).toContain("import '@/assets/fonts/noto-color-emoji/noto-color-emoji.css';");
  });
});
