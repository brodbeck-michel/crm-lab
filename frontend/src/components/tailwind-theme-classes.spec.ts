import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Segunda guarda da regra 5 do CLAUDE.md — a que `no-hardcoded-tokens.spec.ts`
 * NAO consegue dar.
 *
 * Aquele teste procura hex/raio-em-px/nome-de-fonte escritos no componente.
 * Só que a pior violação não se escreve: ela acontece quando a classe usada
 * **não existe no nosso tema** e o Tailwind cai no default dele, que é hex fixo
 * de dentro do `node_modules`.
 *
 *   `bg-neutral-50`      → `#fafafa` LITERAL (tokens.css só define 100..900)
 *   `text-positive-600`  → não existe: a classe some, o texto fica sem cor
 *   `text-body-md`       → não existe: cai no `font-size` herdado
 *   `text-sm`            → existe, mas é a escala DEFAULT do Tailwind
 *                          convivendo com a nossa (duas escalas no mesmo app)
 *
 * Nenhum desses aparece numa varredura de hex, e todos quebram `applyTheme()`
 * ou a escala tipográfica de DESIGN_TOKENS.md em silêncio.
 *
 * Por isso a validação é contra `theme.extend` do `tailwind.config.js` — os
 * tokens que NÓS declaramos — e não contra o tema resolvido: o tema resolvido
 * é o merge com o default do Tailwind, e esse merge É o bug.
 */

const FRONTEND_ROOT = process.cwd();
const SRC = resolve(FRONTEND_ROOT, 'src');

/** Utilitários `text-*`/`bg-*` que não são cor nem tamanho — não são tokens. */
const NON_TOKEN_UTILITIES = new Set([
  // alinhamento / quebra de texto
  'text-left',
  'text-center',
  'text-right',
  'text-justify',
  'text-start',
  'text-end',
  'text-wrap',
  'text-nowrap',
  'text-balance',
  'text-pretty',
  'text-ellipsis',
  'text-clip',
  // palavras-chave de cor herdada (não injetam hex)
  'text-current',
  'text-inherit',
  'text-transparent',
  'bg-current',
  'bg-inherit',
  'bg-transparent',
  // fundo como layout, não como cor
  'bg-none',
  'bg-cover',
  'bg-contain',
  'bg-fixed',
  'bg-local',
  'bg-scroll',
  'bg-repeat',
  'bg-no-repeat',
]);

interface TailwindThemeExtend {
  colors?: Record<string, string | Record<string, string>>;
  fontSize?: Record<string, unknown>;
}

/**
 * Especificador RELATIVO de propósito: o caminho absoluto deste repositório
 * tem espaço e acento, e o resolvedor do Vite não reabre o file:// escapado.
 */
async function loadExtend(): Promise<TailwindThemeExtend> {
  const mod: unknown = await import('../../tailwind.config.js');
  const config = (mod as { default?: unknown }).default;
  const theme = (config as { theme?: { extend?: TailwindThemeExtend } } | undefined)?.theme;
  const extend = theme?.extend;
  if (!extend) throw new Error('tailwind.config.js sem theme.extend');
  return extend;
}

/** `{ accent: { DEFAULT, 100.. } }` → `accent`, `accent-100`, … */
function colorNames(colors: TailwindThemeExtend['colors']): Set<string> {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(colors ?? {})) {
    if (typeof value === 'string') {
      names.add(name);
      continue;
    }
    for (const step of Object.keys(value)) {
      names.add(step === 'DEFAULT' ? name : `${name}-${step}`);
    }
  }
  return names;
}

function collectSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectSources(full));
    } else if (/\.tsx?$/.test(entry) && !/\.spec\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Classes candidatas de um arquivo.
 *
 * Lê só o conteúdo de literais de string (`'…'`, `"…"`, `` `…` ``) e parte em
 * espaço: assim `var(--color-text-secondary)` continua sendo UM token (e não
 * casa) e `data-testid="context-proposal"` não vira `text-proposal`.
 */
const STRING_LITERAL = /'([^'\n\\]*)'|"([^"\n\\]*)"|`([^`\\]*)`/g;
/** Variantes (`hover:`, `md:`, `group-hover:`) não mudam o token de destino. */
const VARIANT_PREFIX = /^(?:[a-z-]+:)+/;

/**
 * Remove comentários preservando a contagem de linhas.
 *
 * Necessário porque um JSDoc CITA classes em crase (`text-positive-600`) para
 * explicar por que elas são proibidas — e o extrator veria a crase como
 * template literal. Comentário é prosa, não classe.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => '\n'.repeat(block.split('\n').length - 1))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
}

function candidateClasses(raw: string): Map<string, number> {
  const source = stripComments(raw);
  const lineOf = (index: number) => source.slice(0, index).split('\n').length;
  const found = new Map<string, number>();

  STRING_LITERAL.lastIndex = 0;
  let match = STRING_LITERAL.exec(source);
  while (match !== null) {
    const content = match[1] ?? match[2] ?? match[3] ?? '';
    for (const raw of content.split(/[\s${}()]+/)) {
      const token = raw.replace(VARIANT_PREFIX, '');
      if (/^(?:text|bg)-[a-z0-9-]+$/.test(token) && !found.has(token)) {
        found.set(token, lineOf(match.index));
      }
    }
    match = STRING_LITERAL.exec(source);
  }
  return found;
}

const extend = await loadExtend();
const COLORS = colorNames(extend.colors);
const FONT_SIZES = new Set(Object.keys(extend.fontSize ?? {}));
const files = collectSources(SRC);

function reasonFor(token: string): string | null {
  if (NON_TOKEN_UTILITIES.has(token)) return null;

  const value = token.replace(/^(?:text|bg)-/, '');

  if (token.startsWith('bg-')) {
    return COLORS.has(value)
      ? null
      : `bg-${value}: "${value}" não é uma cor do tema — o Tailwind cai no default dele (hex fixo, imune a applyTheme). Cores disponíveis: ${[...COLORS].sort().join(', ')}`;
  }

  if (FONT_SIZES.has(value) || COLORS.has(value)) return null;
  return `text-${value}: "${value}" não é um degrau da escala nem uma cor do tema. Degraus: ${[...FONT_SIZES].sort().join(', ')}`;
}

describe('toda classe text-*/bg-* existe no tema do tailwind.config.js', () => {
  it('resolveu o tema e encontrou fontes para inspecionar', () => {
    expect(COLORS.size).toBeGreaterThan(0);
    expect(FONT_SIZES.size).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThan(0);
  });

  it('nenhuma classe de cor/tamanho fora dos tokens declarados', () => {
    const offenders: string[] = [];

    for (const file of files) {
      for (const [token, line] of candidateClasses(readFileSync(file, 'utf8'))) {
        const reason = reasonFor(token);
        if (reason) offenders.push(`${relative(FRONTEND_ROOT, file)}:${line} → ${reason}`);
      }
    }

    expect(offenders, `Classes inexistentes no tema:\n${offenders.join('\n')}`).toEqual([]);
  });
});
