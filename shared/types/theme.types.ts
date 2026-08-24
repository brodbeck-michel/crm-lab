/** Tema por tenant. Backend armazena SO as 5 cores base + radius + font (D-005). */

export type RadiusId = 'reto' | 'suave' | 'redondo';
export type FontId = 'figtree' | 'playfair' | 'system';

export interface Theme {
  /** Cor de acao e atencao. Hex #rrggbb. */
  accent: string;
  /** Cor de estado positivo / ambito interno. Hex #rrggbb. */
  accent2: string;
  /** Fundo da aplicacao. Hex #rrggbb. */
  bg: string;
  /** Superficie tingida de 2o nivel. Hex #rrggbb. */
  surface: string;
  /** Texto principal. Hex #rrggbb. */
  text: string;
  fontId: FontId;
  radiusId: RadiusId;
  brandName: string | null;
  logoUrl: string | null;
}

/** Um dos 5 temas prontos de DESIGN_TOKENS.md. */
export interface ThemePreset {
  id: string;
  name: string;
  accent: string;
  accent2: string;
  bg: string;
  surface: string;
  text: string;
}

export interface UpdateThemeRequest {
  accent?: string;
  accent2?: string;
  bg?: string;
  surface?: string;
  text?: string;
  fontId?: FontId;
  radiusId?: RadiusId;
  brandName?: string | null;
  logoUrl?: string | null;
}
