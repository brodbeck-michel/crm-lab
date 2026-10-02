import type { Theme } from '@crm-lab/shared';

/**
 * Identidade visual PRÓPRIA do console da plataforma (docs/frontend/PAGES.md §11).
 *
 * `/platform/*` é isolado: NÃO usa o tema do tenant. Como todo tema no
 * projeto, isto é o conjunto de cores + radius + font — as variações
 * continuam nascendo por `color-mix` no CSS estático (D-005). Só accent e
 * accent2 pintam a tela: `bg`/`surface`/`text` ficam pelo tipo `Theme`, mas o
 * fundo branco e o texto escuro são fixos para todos (D-250).
 * Fica em `routes/` (não em `components/`) justamente porque componente
 * nenhum pode declarar cor.
 */
export const PLATFORM_THEME: Theme = {
  accent: '#3d5a80',
  accent2: '#5b8c7b',
  bg: '#f2f4f7',
  surface: '#e3e8ee',
  text: '#141a20',
  fontId: 'system',
  radiusId: 'reto',
  brandName: 'CRM Lab · Plataforma',
  logoUrl: null,
};
