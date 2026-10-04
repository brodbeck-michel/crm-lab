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
        // Agenda de visitas (CRMLAB-92, D-262): `border-agenda-line`, `bg-visit-agendada-bg`…
        agenda: {
          ink: 'var(--color-agenda-ink)',
          'ink-2': 'var(--color-agenda-ink-2)',
          muted: 'var(--color-agenda-muted)',
          'muted-2': 'var(--color-agenda-muted-2)',
          alt: 'var(--color-agenda-alt)',
          rail: 'var(--color-agenda-rail)',
          weekend: 'var(--color-agenda-weekend)',
          hover: 'var(--color-agenda-hover)',
          press: 'var(--color-agenda-press)',
          seg: 'var(--color-agenda-seg)',
          selected: 'var(--color-agenda-selected)',
          line: 'var(--color-agenda-line)',
          'line-soft': 'var(--color-agenda-line-soft)',
          'line-control': 'var(--color-agenda-line-control)',
          'line-hover': 'var(--color-agenda-line-hover)',
          now: 'var(--color-agenda-now)',
          danger: 'var(--color-agenda-danger)',
          'brand-tint': 'var(--color-agenda-brand-tint)',
          'brand-col': 'var(--color-agenda-brand-col)',
        },
        ...Object.fromEntries(
          ['agendada', 'realizada', 'nao-recebeu', 'cancelada'].map((status) => [
            `visit-${status}`,
            {
              bg: `var(--color-visit-${status}-bg)`,
              ink: `var(--color-visit-${status}-ink)`,
              dot: `var(--color-visit-${status}-dot)`,
            },
          ]),
        ),
        // Estágios do pipeline (CRMLAB-91, D-260): `bg-stage-ganho-tint`, `text-stage-ganho-ink`…
        'stage-novo': {
          DEFAULT: 'var(--color-stage-novo)',
          tint: 'var(--color-stage-novo-tint)',
          soft: 'var(--color-stage-novo-soft)',
          ink: 'var(--color-stage-novo-ink)',
        },
        'stage-enviado': {
          DEFAULT: 'var(--color-stage-enviado)',
          tint: 'var(--color-stage-enviado-tint)',
          soft: 'var(--color-stage-enviado-soft)',
          ink: 'var(--color-stage-enviado-ink)',
        },
        'stage-followup': {
          DEFAULT: 'var(--color-stage-followup)',
          tint: 'var(--color-stage-followup-tint)',
          soft: 'var(--color-stage-followup-soft)',
          ink: 'var(--color-stage-followup-ink)',
        },
        'stage-negociacao': {
          DEFAULT: 'var(--color-stage-negociacao)',
          tint: 'var(--color-stage-negociacao-tint)',
          soft: 'var(--color-stage-negociacao-soft)',
          ink: 'var(--color-stage-negociacao-ink)',
        },
        'stage-ganho': {
          DEFAULT: 'var(--color-stage-ganho)',
          tint: 'var(--color-stage-ganho-tint)',
          soft: 'var(--color-stage-ganho-soft)',
          ink: 'var(--color-stage-ganho-ink)',
        },
        'stage-perdido': {
          DEFAULT: 'var(--color-stage-perdido)',
          tint: 'var(--color-stage-perdido-tint)',
          soft: 'var(--color-stage-perdido-soft)',
          ink: 'var(--color-stage-perdido-ink)',
        },
        // Conversa do atendimento (CRMLAB-25 → CRMLAB-81, D-251) — visual WhatsApp Web.
        chat: {
          panel: 'var(--color-chat-panel)',
          line: 'var(--color-chat-line)',
          selected: 'var(--color-chat-selected)',
          hover: 'var(--color-chat-hover)',
          avatar: 'var(--color-chat-avatar)',
          'avatar-text': 'var(--color-chat-avatar-text)',
          bg: 'var(--color-chat-bg)',
          received: 'var(--color-chat-received)',
          sent: 'var(--color-chat-sent)',
          text: 'var(--color-chat-text)',
          meta: 'var(--color-chat-meta)',
          quote: 'var(--color-chat-quote)',
          'quote-hover': 'var(--color-chat-quote-hover)',
          'tick-read': 'var(--color-chat-tick-read)',
          alert: 'var(--color-chat-alert)',
          'alert-bg': 'var(--color-chat-alert-bg)',
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
