import type { Theme, ThemePreset } from '@crm-lab/shared';

/**
 * Aplicação do tema (docs/frontend/PAGES.md — "Aplicação do Tema").
 *
 * Escreve SÓ as 5 cores base + os data-attributes no elemento raiz.
 * As 27 variações (rampas 100–900 de accent, accent-2 e neutral) são
 * derivadas por `color-mix(in oklab, ...)` no CSS estático (D-005) —
 * este arquivo nunca calcula cor.
 *
 * Nenhum componente lê o objeto Theme direto: componentes leem só CSS vars.
 */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.style.setProperty('--color-accent', theme.accent);
  root.style.setProperty('--color-accent-2', theme.accent2);
  root.style.setProperty('--color-bg', theme.bg);
  root.style.setProperty('--color-surface', theme.surface);
  root.style.setProperty('--color-text', theme.text);

  root.dataset.radius = theme.radiusId; // reto | suave | redondo
  root.dataset.font = theme.fontId; // figtree | playfair | system
}

/**
 * Aplica só as 5 cores de um preset, preservando radiusId/fontId atuais.
 * Usado pela prévia ao vivo da tela de Personalização.
 */
export function applyThemeColors(
  preset: ThemePreset,
  root: HTMLElement = document.documentElement,
): void {
  root.style.setProperty('--color-accent', preset.accent);
  root.style.setProperty('--color-accent-2', preset.accent2);
  root.style.setProperty('--color-bg', preset.bg);
  root.style.setProperty('--color-surface', preset.surface);
  root.style.setProperty('--color-text', preset.text);
}

/**
 * Os 5 temas prontos de docs/design/DESIGN_TOKENS.md.
 * Os `id` batem com os do protótipo `Design System CRM.dc.html` (seção 03).
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
