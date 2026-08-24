/**
 * Os 5 temas prontos de `docs/design/DESIGN_TOKENS.md`.
 *
 * O backend guarda SO as 5 cores base + fontId + radiusId (D-005); as 27
 * variacoes sao derivadas no frontend com `color-mix(in oklab)`.
 */
import type { FontId, RadiusId } from '@crm-lab/shared';

export interface SeedThemePreset {
  id: string;
  name: string;
  accent: string;
  accent2: string;
  bg: string;
  surface: string;
  text: string;
}

export const THEME_TERRACOTA: SeedThemePreset = {
  id: 'terracota',
  name: 'Terracota & Sálvia',
  accent: '#c67139',
  accent2: '#7a8a5e',
  bg: '#f5ead8',
  surface: '#ebddc5',
  text: '#1a1a1a',
};

export const THEME_AZUL_JALECO: SeedThemePreset = {
  id: 'azul-jaleco',
  name: 'Azul Jaleco',
  accent: '#2f6f9f',
  accent2: '#4f9d8b',
  bg: '#eef3f7',
  surface: '#dbe6ef',
  text: '#1a1a1a',
};

export const THEME_VERDE_ESTERILIZADO: SeedThemePreset = {
  id: 'verde-esterilizado',
  name: 'Verde Esterilizado',
  accent: '#2f7d5f',
  accent2: '#6d8f4e',
  bg: '#eef5f0',
  surface: '#d9e8de',
  text: '#1a1a1a',
};

export const THEME_HEMOGRAMA: SeedThemePreset = {
  id: 'hemograma',
  name: 'Hemograma',
  accent: '#a63a3a',
  accent2: '#7a6b8a',
  bg: '#f7efee',
  surface: '#ecdad8',
  text: '#1a1a1a',
};

export const THEME_LILAS_DIAGNOSTICO: SeedThemePreset = {
  id: 'lilas-diagnostico',
  name: 'Lilás Diagnóstico',
  accent: '#6a4f9c',
  accent2: '#3f8a9a',
  bg: '#f3f1f8',
  surface: '#e2dcef',
  text: '#1a1a1a',
};

export const THEME_PRESETS: readonly SeedThemePreset[] = [
  THEME_TERRACOTA,
  THEME_AZUL_JALECO,
  THEME_VERDE_ESTERILIZADO,
  THEME_HEMOGRAMA,
  THEME_LILAS_DIAGNOSTICO,
];

export const DEFAULT_FONT_ID: FontId = 'figtree';
export const DEFAULT_RADIUS_ID: RadiusId = 'suave';
