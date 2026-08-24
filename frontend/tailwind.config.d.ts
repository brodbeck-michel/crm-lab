/**
 * Tipos do `tailwind.config.js` — ele é JS puro, e `tailwind-theme-classes.spec.ts`
 * o importa para validar as classes usadas contra os tokens declarados.
 *
 * Declarado à mão (em vez de `allowJs`) para que o teste leia o tema com tipo,
 * sem `any` (CLAUDE.md §6). Só o que o teste consome está descrito aqui.
 */
declare const config: {
  content: string[];
  theme: {
    extend: {
      /** `'var(--color-bg)'` ou uma rampa `{ DEFAULT, 100..900 }`. */
      colors: Record<string, string | Record<string, string>>;
      /** Degraus da escala de DESIGN_TOKENS.md: display, metric, section, … */
      fontSize: Record<string, unknown>;
      [key: string]: unknown;
    };
  };
  plugins: unknown[];
};

export default config;
