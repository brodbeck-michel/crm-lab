/**
 * Ponte entre os design tokens e o Recharts.
 *
 * O Recharts pinta eixo, grade e tooltip via PROPS (`stroke`, `fill`,
 * `fontSize`), não via classe — então os tokens precisam chegar até ele como
 * valor. Ficam aqui, num lugar só, para que nenhuma tela invente um
 * `var(--color-*)` que não existe (foi exatamente o que aconteceu com
 * `--color-text-secondary` / `--color-border` / `--color-success`).
 *
 * Todo valor abaixo é um token de docs/design/DESIGN_TOKENS.md — nada de hex.
 */

/** Texto secundário (DESIGN_TOKENS: "Legendas, placeholder"). */
export const CHART_AXIS_COLOR = 'var(--color-neutral-600)';

/** Bordas e divisores (DESIGN_TOKENS: "Linhas de tabela"). */
export const CHART_GRID_COLOR = 'var(--color-neutral-300)';

/** Ação/atenção — série primária e série de "exige atenção". */
export const CHART_ACCENT_COLOR = 'var(--color-accent)';

/** Estado positivo/ganho — série de receita. */
export const CHART_POSITIVE_COLOR = 'var(--color-accent-2)';

/**
 * Degrau mais escuro do positivo — série de MAIOR volume quando três séries
 * dividem o mesmo gráfico (orçado > requisição > recebido). Três séries do
 * mesmo gráfico precisam de três cores separáveis, e inventar uma quarta matiz
 * fora do tema quebraria a identidade do tenant.
 */
export const CHART_POSITIVE_DEEP_COLOR = 'var(--color-accent-2-800)';

/**
 * Degrau `caption` da escala tipográfica (12px). Numérico porque o Recharts
 * mede o texto em JS; a fonte de verdade continua sendo o mesmo 12px de
 * `fontSize.caption` no tailwind.config.js.
 */
export const CHART_TICK_FONT_SIZE = 12;

/** Estilo de tick de eixo — cor + degrau tipográfico, num objeto só. */
export const CHART_TICK = {
  fill: CHART_AXIS_COLOR,
  fontSize: CHART_TICK_FONT_SIZE,
} as const;

/** Caixa do tooltip: superfície tingida com borda de divisor. */
export const CHART_TOOLTIP_CONTENT_STYLE = {
  backgroundColor: 'var(--color-surface)',
  border: `1px solid ${CHART_GRID_COLOR}`,
} as const;

export const CHART_TOOLTIP_LABEL_STYLE = { color: 'var(--color-text)' } as const;

/**
 * Recharts entrega o valor do tooltip como `string | number | Array<...>`.
 * Narrowing explícito — `as number` mentiria quando a série vier vazia.
 */
export function toChartNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
