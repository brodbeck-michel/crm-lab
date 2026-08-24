import { forwardRef, useId } from 'react';
import type { SelectHTMLAttributes } from 'react';
import { cn } from './cn';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'children'> {
  options: SelectOption[];
  label?: string;
  error?: string;
  /** Opção vazia inicial (ex.: "Selecione o motivo"). */
  placeholder?: string;
}

/** Seta em SVG — o `appearance-none` remove o widget do navegador. */
function ChevronIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none absolute right-lg top-1/2 -translate-y-1/2 text-neutral-600"
    >
      <path d="M2.5 4.5 L6 8 L9.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Select estilizado com tokens — nada de padrão do navegador. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, label, error, placeholder, id, disabled, ...rest },
  ref,
) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;

  return (
    <div className="flex w-full flex-col gap-xs">
      {label && (
        <label htmlFor={fieldId} className="font-body text-caption font-semibold text-neutral-700">
          {label}
        </label>
      )}

      <div className="relative w-full">
        <select
          {...rest}
          id={fieldId}
          ref={ref}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          className={cn(
            'w-full appearance-none rounded-pill border bg-bg py-[10px] pl-lg pr-xl',
            'cursor-pointer font-body text-label text-text outline-none transition-colors',
            'focus:border-accent',
            error ? 'border-accent-600' : 'border-neutral-300',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronIcon />
      </div>

      {error && (
        <span role="alert" className="font-body text-caption text-accent-700">
          {error}
        </span>
      )}
    </div>
  );
});
