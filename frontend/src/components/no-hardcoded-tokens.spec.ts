import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guarda automática da regra 5 do CLAUDE.md:
 * "zero hex, zero px de raio, zero nome de fonte em componente — só tokens CSS".
 *
 * Este teste lê TODO `.tsx` de `src/components/` e falha se encontrar:
 *   1. cor em hex (#rgb / #rrggbb / #rrggbbaa)
 *   2. `font-family` com nome literal de fonte
 *   3. `border-radius` (ou classe `rounded-[…]`) em px que não seja 999px
 *
 * Cor, fonte e raio são configuração por tenant (D-005). Um hex num componente
 * quebra a tela de Personalização em silêncio — por isso é teste, não revisão.
 */

/**
 * Vitest roda com cwd em `frontend/`.
 *
 * A varredura cobre `src/components/` E `src/pages/`: a regra vale para
 * qualquer `.tsx`, e uma TELA com hex quebra a Personalizacao do mesmo jeito
 * que um componente (ampliado pelo Agent-UI-Attendance).
 */
const SCANNED_DIRS = ['src/components', 'src/pages'].map((dir) => resolve(process.cwd(), dir));

function collectTsx(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectTsx(full));
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.spec.tsx')) {
      found.push(full);
    }
  }
  return found;
}

const files = SCANNED_DIRS.flatMap(collectTsx);

/** Ignora linhas de comentário — os docs citam tokens e exemplos. */
function codeLines(source: string): Array<{ line: number; text: string }> {
  let inBlockComment = false;
  return source
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => {
      const trimmed = text.trim();
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        return false;
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true;
        return false;
      }
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    });
}

const HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?\b/;
const FONT_FAMILY = /font-?[fF]amily\s*[:=]/;
const RADIUS_PX = /(?:border-?[rR]adius\s*[:=]\s*|rounded(?:-[a-z]+)?-\[)\s*['"]?(-?\d+(?:\.\d+)?)px/g;

describe('nenhum token hardcoded nos componentes', () => {
  it('encontrou arquivos .tsx para inspecionar', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s não declara cor em hex', (file) => {
    const offenders = codeLines(readFileSync(file, 'utf8'))
      .filter(({ text }) => HEX.test(text))
      .map(({ line, text }) => `linha ${line}: ${text.trim()}`);

    expect(
      offenders,
      `Use uma CSS var / classe Tailwind mapeada em vez de hex:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it.each(files)('%s não declara font-family literal', (file) => {
    const offenders = codeLines(readFileSync(file, 'utf8'))
      .filter(({ text }) => FONT_FAMILY.test(text))
      .map(({ line, text }) => `linha ${line}: ${text.trim()}`);

    expect(
      offenders,
      `Use font-heading / font-body (var(--font-*)) em vez de nome de fonte:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it.each(files)('%s não declara border-radius em px (exceto 999px)', (file) => {
    const offenders: string[] = [];

    for (const { line, text } of codeLines(readFileSync(file, 'utf8'))) {
      RADIUS_PX.lastIndex = 0;
      let match = RADIUS_PX.exec(text);
      while (match !== null) {
        if (match[1] !== '999') {
          offenders.push(`linha ${line}: ${text.trim()}`);
        }
        match = RADIUS_PX.exec(text);
      }
    }

    expect(
      offenders,
      `Use rounded-sm/md/lg (var(--radius-*)) ou rounded-pill (999px):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
