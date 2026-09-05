import type { ReactNode } from 'react';
import { cn } from './cn';

export type ChipTone = 'positive' | 'attention' | 'inactive';

export interface ChipProps {
  /**
   * - `positive` (accent-2 200/800): estado neutro ou positivo.
   * - `attention` (accent 200/800): exige ação humana — **máx. 1 por cartão**.
   * - `inactive` (neutral-200): filtro desligado.
   */
  tone?: ChipTone;
  /** Presente ⇒ o chip vira `<button>`. Ausente ⇒ `<span>` não interativo. */
  onClick?: () => void;
  /** Estado ligado de um chip de filtro (só faz sentido com `onClick`). */
  selected?: boolean;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}

const BASE =
  'inline-flex items-center gap-xs rounded-pill px-[11px] py-[3px] text-caption ' +
  'font-body whitespace-nowrap flex-[0_0_auto]';

const TONES: Record<ChipTone, string> = {
  positive: 'bg-accent2-200 text-accent2-800 font-semibold',
  attention: 'bg-accent-200 text-accent-800 font-bold',
  inactive: 'bg-neutral-200 text-neutral-700 font-normal',
};

const CLICKABLE_TONES: Record<ChipTone, string> = {
  positive: 'hover:bg-accent2-300',
  attention: 'hover:bg-accent-300',
  inactive: 'hover:bg-neutral-300',
};

/**
 * Estado LIGADO de um chip de filtro. Antes era só `shadow-sm` — uma sombra
 * numa pílula pequena não se lê como "este filtro está ativo", e quem trocava
 * de aba não sabia em qual estava. Contorno na cor do próprio tom: visível sem
 * depender só de cor de fundo (a mesma pílula muda de forma, não só de matiz).
 */
const SELECTED_TONES: Record<ChipTone, string> = {
  positive: 'ring-2 ring-accent2-800',
  attention: 'ring-2 ring-accent-800',
  inactive: 'ring-2 ring-neutral-700',
};

/** Etiqueta de estado/filtro. Clicável apenas quando recebe `onClick`. */
export function Chip({
  tone = 'inactive',
  onClick,
  selected = false,
  disabled = false,
  title,
  children,
}: ChipProps) {
  if (!onClick) {
    return (
      <span data-tone={tone} title={title} className={cn(BASE, TONES[tone])}>
        {children}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-tone={tone}
      title={title}
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        BASE,
        TONES[tone],
        'cursor-pointer border-none transition-colors',
        CLICKABLE_TONES[tone],
        selected && SELECTED_TONES[tone],
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {children}
    </button>
  );
}
