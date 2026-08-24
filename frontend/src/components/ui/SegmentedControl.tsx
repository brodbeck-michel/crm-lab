import { useRef } from 'react';
import { cn } from './cn';

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Rótulo acessível do grupo. */
  'aria-label'?: string;
}

/**
 * Trilho com pílula deslizante — **NUNCA abas sublinhadas** (COMPONENTS.md).
 *
 * Teclado: ← → (e ↑ ↓) navegam e trocam o valor; Home/End vão às pontas.
 * Segue o padrão ARIA de tablist com seleção automática.
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (from: number, delta: number) => {
    const total = options.length;
    if (total === 0) return;

    let next = from;
    for (let step = 0; step < total; step += 1) {
      next = (next + delta + total) % total;
      const candidate = options[next];
      if (candidate && !candidate.disabled) {
        onChange(candidate.value);
        refs.current[next]?.focus();
        return;
      }
    }
  };

  const jump = (direction: 'start' | 'end') => {
    const ordered = direction === 'start' ? options : [...options].reverse();
    const target = ordered.find((option) => !option.disabled);
    if (!target) return;
    onChange(target.value);
    refs.current[options.indexOf(target)]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex w-full gap-xs rounded-pill bg-bg p-xs"
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            data-state={active ? 'active' : 'inactive'}
            disabled={option.disabled}
            tabIndex={active ? 0 : -1}
            ref={(node) => {
              refs.current[index] = node;
            }}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                move(index, -1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                jump('start');
              } else if (event.key === 'End') {
                event.preventDefault();
                jump('end');
              }
            }}
            className={cn(
              'flex-1 cursor-pointer whitespace-nowrap rounded-pill border-none px-md py-[7px]',
              'text-center font-body text-caption transition-colors',
              active
                ? 'bg-accent font-semibold text-bg'
                : 'bg-transparent text-neutral-700 hover:bg-accent-100',
              option.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
