import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'size' | 'prefix'> {
  /** Rótulo acima do campo. Sempre associado via `htmlFor`. */
  label?: string;
  /** Mensagem de erro; aplica contorno accent e `aria-invalid`. */
  error?: string;
  /** Texto auxiliar abaixo do campo (some quando há `error`). */
  hint?: string;
  /** Conteúdo antes do campo, dentro da pílula (ícone). */
  prefix?: ReactNode;
  /** Conteúdo depois do campo, dentro da pílula (ação, unidade). */
  suffix?: ReactNode;
}

/** Campo de UMA LINHA — pílula 999px, conforme DESIGN_TOKENS.md. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, prefix, suffix, id, disabled, ...rest },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="flex w-full flex-col gap-xs">
      {label && (
        <label htmlFor={inputId} className="font-body text-caption font-semibold text-neutral-700">
          {label}
        </label>
      )}

      <div
        className={cn(
          'flex w-full items-center gap-sm rounded-pill border bg-bg px-lg py-[10px]',
          'transition-colors focus-within:border-accent',
          error ? 'border-accent-600' : 'border-neutral-300',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        {prefix && <span className="flex flex-[0_0_auto] items-center text-neutral-600">{prefix}</span>}
        <input
          {...rest}
          id={inputId}
          ref={ref}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'min-w-0 flex-1 border-none bg-transparent font-body text-label text-text outline-none',
            'placeholder:text-neutral-600 disabled:cursor-not-allowed',
          )}
        />
        {suffix && <span className="flex flex-[0_0_auto] items-center text-neutral-600">{suffix}</span>}
      </div>

      {error ? (
        <span id={`${inputId}-error`} role="alert" className="font-body text-caption text-accent-700">
          {error}
        </span>
      ) : hint ? (
        <span id={`${inputId}-hint`} className="font-body text-caption text-neutral-600">
          {hint}
        </span>
      ) : null}
    </div>
  );
});
