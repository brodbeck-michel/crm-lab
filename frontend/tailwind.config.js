/**
 * Tema do Tailwind mapeado 100% para CSS vars — NUNCA para hex.
 * É isso que faz `bg-accent-200` continuar respeitando o tema do tenant
 * quando applyTheme() reescreve as 5 cores base em runtime (D-005).
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg)',
        surface: 'var(--color-surface)',
        text: 'var(--color-text)',
        ink: 'var(--color-text)',
        backdrop: 'var(--color-backdrop)',
        // Conversa do atendimento (CRMLAB-25) — papel branco + bolhas tingidas.
        chat: {
          bg: 'var(--color-chat-bg)',
          received: 'var(--color-chat-received)',
          'received-border': 'var(--color-chat-received-border)',
          sent: 'var(--color-chat-sent)',
          'sent-border': 'var(--color-chat-sent-border)',
        },
        accent: {
          DEFAULT: 'var(--color-accent)',
          100: 'var(--color-accent-100)',
          200: 'var(--color-accent-200)',
          300: 'var(--color-accent-300)',
          400: 'var(--color-accent-400)',
          500: 'var(--color-accent-500)',
          600: 'var(--color-accent-600)',
          700: 'var(--color-accent-700)',
          800: 'var(--color-accent-800)',
          900: 'var(--color-accent-900)',
        },
        accent2: {
          DEFAULT: 'var(--color-accent-2)',
          100: 'var(--color-accent-2-100)',
          200: 'var(--color-accent-2-200)',
          300: 'var(--color-accent-2-300)',
          400: 'var(--color-accent-2-400)',
          500: 'var(--color-accent-2-500)',
          600: 'var(--color-accent-2-600)',
          700: 'var(--color-accent-2-700)',
          800: 'var(--color-accent-2-800)',
          900: 'var(--color-accent-2-900)',
        },
        neutral: {
          DEFAULT: 'var(--color-neutral)',
          100: 'var(--color-neutral-100)',
          200: 'var(--color-neutral-200)',
          300: 'var(--color-neutral-300)',
          400: 'var(--color-neutral-400)',
          500: 'var(--color-neutral-500)',
          600: 'var(--color-neutral-600)',
          700: 'var(--color-neutral-700)',
          800: 'var(--color-neutral-800)',
          900: 'var(--color-neutral-900)',
        },
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        // Pílula é 999px LITERAL — independe do tema (DESIGN_TOKENS.md).
        pill: '999px',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
      },
      fontFamily: {
        heading: 'var(--font-heading)',
        body: 'var(--font-body)',
      },
      fontSize: {
        // Escala tipográfica de DESIGN_TOKENS.md
        display: ['32px', { lineHeight: '1.08', letterSpacing: '-0.015em' }],
        metric: ['30px', { lineHeight: '1.1', letterSpacing: '-0.015em' }],
        section: ['21px', { lineHeight: '1.2', letterSpacing: '-0.015em' }],
        label: ['13.5px', { lineHeight: '1.4' }],
        body: ['13px', { lineHeight: '1.55' }],
        caption: ['12px', { lineHeight: '1.45' }],
        micro: ['11px', { lineHeight: '1.4', letterSpacing: '0.08em' }],
      },
      spacing: {
        xs: 'var(--gap-xs)',
        sm: 'var(--gap-sm)',
        md: 'var(--gap-md)',
        lg: 'var(--gap-lg)',
        xl: 'var(--gap-xl)',
      },
      maxWidth: {
        modal: '720px',
      },
    },
  },
  plugins: [],
};
