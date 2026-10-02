import type { Theme, ThemePreset } from '@crm-lab/shared';

/**
 * Aplicação do tema (docs/frontend/PAGES.md — "Aplicação do Tema").
 *
 * Escreve SÓ `--color-accent` e `--color-accent-2` + os data-attributes no
 * elemento raiz (D-250). Fundo, superfície e texto são FIXOS em `tokens.css`
 * — o `bg`/`surface`/`text` que o tema do tenant ainda traz (contrato
 * inalterado, temas antigos salvos) é ignorado de propósito. As variações
 * (rampas 100–900, tons do menu/cartão/tabela) são derivadas por
 * `color-mix(in oklab, ...)` no CSS estático (D-005) — este arquivo nunca
 * calcula cor.
 *
 * Nenhum componente lê o objeto Theme direto: componentes leem só CSS vars.
 */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  applyThemeColors(theme, root);

  root.dataset.radius = theme.radiusId; // reto | suave | redondo
  root.dataset.font = theme.fontId; // figtree | playfair | system
}

/** Variáveis que o tema do tenant NÃO controla mais (D-250). */
const FIXED_VARS = ['--color-bg', '--color-surface', '--color-text'] as const;

/**
 * Aplica só as 2 cores do tema (accent + accent2), preservando radiusId/fontId
 * atuais. Remove um `--color-bg/-surface/-text` inline que tenha sobrado de
 * uma versão anterior, para o valor fixo de `tokens.css` valer.
 */
export function applyThemeColors(
  colors: Pick<ThemePreset, 'accent' | 'accent2'>,
  root: HTMLElement = document.documentElement,
): void {
  root.style.setProperty('--color-accent', colors.accent);
  root.style.setProperty('--color-accent-2', colors.accent2);
  for (const name of FIXED_VARS) root.style.removeProperty(name);
}

/**
 * Os 5 temas prontos de docs/design/DESIGN_TOKENS.md.
 * Os `id` batem com os do protótipo `Design System CRM.dc.html` (seção 03).
 * `bg`/`surface`/`text` ficam por compatibilidade com o contrato
 * (`ThemePreset`), mas a tela só usa accent e accent2 (D-250).
 */
export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'terracota',
    name: 'Terracota & Sálvia',
    accent: '#c67139',
    accent2: '#7a8a5e',
    bg: '#f5ead8',
    surface: '#ebddc5',
    text: '#1a1a1a',
  },
  {
    id: 'jaleco',
    name: 'Azul Jaleco',
    accent: '#2f6f9f',
    accent2: '#4f9d8b',
    bg: '#eef3f7',
    surface: '#dbe6ef',
    text: '#1a1a1a',
  },
  {
    id: 'esteril',
    name: 'Verde Esterilizado',
    accent: '#2f7d5f',
    accent2: '#6d8f4e',
    bg: '#eef5f0',
    surface: '#d9e8de',
    text: '#1a1a1a',
  },
  {
    id: 'hemograma',
    name: 'Hemograma',
    accent: '#a63a3a',
    accent2: '#7a6b8a',
    bg: '#f7efee',
    surface: '#ecdad8',
    text: '#1a1a1a',
  },
  {
    id: 'diagnostico',
    name: 'Lilás Diagnóstico',
    accent: '#6a4f9c',
    accent2: '#3f8a9a',
    bg: '#f3f1f8',
    surface: '#e2dcef',
    text: '#1a1a1a',
  },
];

/** Tema padrão (Tema 1), espelhando o `:root` de `src/styles/tokens.css`. */
export const DEFAULT_THEME: Theme = {
  accent: '#c67139',
  accent2: '#7a8a5e',
  bg: '#f5ead8',
  surface: '#ebddc5',
  text: '#1a1a1a',
  fontId: 'playfair',
  radiusId: 'suave',
  brandName: null,
  logoUrl: null,
};
