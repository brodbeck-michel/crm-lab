import { useId } from 'react';
import { cn } from './cn';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Texto ao lado do interruptor. */
  label?: string;
  disabled?: boolean;
  'aria-label'?: string;
}

/** Interruptor pílula. Estado ligado usa accent-2 (positivo/ativo). */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  'aria-label': ariaLabel,
}: ToggleProps) {
  const labelId = useId();

  return (
    <span className="inline-flex items-center gap-sm">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label ? undefined : ariaLabel}
        aria-labelledby={label ? labelId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'inline-flex h-[20px] w-[36px] flex-[0_0_36px] cursor-pointer items-center',
          'rounded-pill border-none p-[2px] transition-colors',
          checked ? 'bg-accent2 justify-end' : 'bg-neutral-300 justify-start',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span
          aria-hidden="true"
          className="block h-[16px] w-[16px] flex-[0_0_16px] rounded-pill bg-bg shadow-sm"
        />
      </button>
      {label && (
        <span id={labelId} className="font-body text-label text-text">
          {label}
        </span>
      )}
    </span>
  );
}
