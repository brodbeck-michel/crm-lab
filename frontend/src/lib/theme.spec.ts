import { beforeEach, describe, expect, it } from 'vitest';
import type { Theme } from '@crm-lab/shared';
import { applyTheme, applyThemeColors, DEFAULT_THEME, THEME_PRESETS } from './theme';

const theme: Theme = {
  accent: '#2f6f9f',
  accent2: '#4f9d8b',
  bg: '#eef3f7',
  surface: '#dbe6ef',
  text: '#1a1a1a',
  fontId: 'system',
  radiusId: 'reto',
  brandName: 'Lab Exemplo',
  logoUrl: null,
};

describe('applyTheme', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-radius');
    document.documentElement.removeAttribute('data-font');
  });

  it('escreve as 5 cores base no elemento raiz', () => {
    applyTheme(theme);
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--color-accent')).toBe('#2f6f9f');
    expect(root.style.getPropertyValue('--color-accent-2')).toBe('#4f9d8b');
    expect(root.style.getPropertyValue('--color-bg')).toBe('#eef3f7');
    expect(root.style.getPropertyValue('--color-surface')).toBe('#dbe6ef');
    expect(root.style.getPropertyValue('--color-text')).toBe('#1a1a1a');
  });

  it('escreve os data-attributes de raio e fonte', () => {
    applyTheme(theme);
    expect(document.documentElement.getAttribute('data-radius')).toBe('reto');
    expect(document.documentElement.getAttribute('data-font')).toBe('system');
  });

  it('NÃO escreve as rampas derivadas — elas nascem no CSS (D-005)', () => {
    applyTheme(theme);
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--color-accent-200')).toBe('');
    expect(root.style.getPropertyValue('--color-neutral-600')).toBe('');
  });

  it('aceita um elemento alvo explícito', () => {
    const target = document.createElement('div');
    applyTheme(theme, target);
    expect(target.style.getPropertyValue('--color-accent')).toBe('#2f6f9f');
    expect(target.dataset.radius).toBe('reto');
  });

  it('reaplicar troca o tema por inteiro', () => {
    applyTheme(theme);
    applyTheme({ ...theme, accent: '#a63a3a', radiusId: 'redondo', fontId: 'figtree' });
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--color-accent')).toBe('#a63a3a');
    expect(root.getAttribute('data-radius')).toBe('redondo');
    expect(root.getAttribute('data-font')).toBe('figtree');
  });
});

describe('applyThemeColors', () => {
  it('troca só as cores, preservando raio e fonte', () => {
    const target = document.createElement('div');
    applyTheme(theme, target);

    const preset = THEME_PRESETS[3];
    expect(preset).toBeDefined();
    if (!preset) return;

    applyThemeColors(preset, target);
    expect(target.style.getPropertyValue('--color-accent')).toBe(preset.accent);
    expect(target.dataset.radius).toBe('reto');
    expect(target.dataset.font).toBe('system');
  });
});

describe('THEME_PRESETS', () => {
  it('tem os 5 temas de DESIGN_TOKENS.md', () => {
    expect(THEME_PRESETS).toHaveLength(5);
    expect(THEME_PRESETS.map((preset) => preset.id)).toEqual([
      'terracota',
      'jaleco',
      'esteril',
      'hemograma',
      'diagnostico',
    ]);
  });

  it('todo preset traz as 5 cores em hex', () => {
    for (const preset of THEME_PRESETS) {
      for (const key of ['accent', 'accent2', 'bg', 'surface', 'text'] as const) {
        expect(preset[key]).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('o tema padrão é o Terracota & Sálvia do :root', () => {
    const terracota = THEME_PRESETS[0];
    expect(terracota).toBeDefined();
    expect(DEFAULT_THEME.accent).toBe(terracota?.accent);
    expect(DEFAULT_THEME.accent2).toBe(terracota?.accent2);
    expect(DEFAULT_THEME.radiusId).toBe('suave');
    expect(DEFAULT_THEME.fontId).toBe('playfair');
  });
});
