import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'confirmation' | 'destructive';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  /**
   * - `primary`: fundo accent, texto bg. **Um por área da tela.**
   * - `secondary`: contorno neutro, fundo transparente. Ação de apoio.
   * - `confirmation`: fundo accent-2. **RESERVADO** a concluir/positivo —
   *   marcar ganho, aprovar desconto, confirmar agendamento, enviar interno.
   *   NÃO use como "botão bonito" para uma ação neutra: o accent-2 é o sinal
   *   de "isto fechou bem" em todo o produto, e usá-lo fora disso quebra a
   *   leitura de estado nas telas de pipeline e aprovação.
   * - `destructive`: fantasma accent-700. Perda e remoção.
   */
  variant?: ButtonVariant;
  /** `md` (36px, padrão) ou `sm` (32px, densidade alta em barras de filtro). */
  size?: ButtonSize;
  /** Bloqueia o clique e mostra o indicador. `onClick` não dispara. */
  loading?: boolean;
  children?: ReactNode;
}

const BASE =
  'inline-flex items-center justify-center gap-sm rounded-pill font-body font-semibold ' +
  'cursor-pointer transition-colors select-none whitespace-nowrap border ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-bg border-transparent hover:bg-accent-600 active:bg-accent-600',
  secondary:
    'bg-transparent text-text border-neutral-400 hover:bg-neutral-200 active:bg-neutral-300',
  confirmation:
    'bg-accent2 text-bg border-transparent hover:bg-accent2-700 active:bg-accent2-700',
  destructive:
    'bg-transparent text-accent-700 border-transparent hover:bg-accent-100 active:bg-accent-200',
};

const SIZES: Record<ButtonSize, string> = {
  // Altura mínima 36px — alvo de toque de desktop (DESIGN_TOKENS.md §Estados).
  md: 'min-h-[36px] px-[18px] py-[10px] text-body',
  sm: 'min-h-[32px] px-md py-[7px] text-caption',
};

/**
 * Botão pílula do design system. Sempre `border-radius: 999px`,
 * altura mínima 36px em `md`, foco de teclado com outline accent.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const isBlocked = disabled || loading;

  return (
    <button
      type={type}
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      disabled={isBlocked}
      aria-busy={loading || undefined}
      className={cn(BASE, VARIANTS[variant], SIZES[size])}
      {...rest}
    >
      {loading && (
        <span
          aria-hidden="true"
          data-testid="button-spinner"
          className="inline-block h-[12px] w-[12px] flex-[0_0_12px] rounded-pill border-2 border-current border-r-transparent motion-safe:animate-spin"
        />
      )}
      {children}
    </button>
  );
}
