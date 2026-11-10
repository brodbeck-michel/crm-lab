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
  /**
   * `true` (padrão): o trilho ocupa a largura toda e as opções dividem o espaço.
   * `false`: o trilho abraça o conteúdo — para 2–5 opções curtas que não devem
   * esticar numa tela larga (CRMLAB-143).
   */
  fullWidth?: boolean;
  /**
   * `sm` (padrão): filtro dentro de uma tela. `md`: abas que trocam o conteúdo
   * da página (Cadastros, Regras) — trilho com fundo e borda, rótulo maior.
   */
  size?: 'sm' | 'md';
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
  fullWidth = true,
  size = 'sm',
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
      className={cn(
        'inline-flex max-w-full gap-xs rounded-pill p-xs',
        fullWidth ? 'w-full' : 'flex-wrap',
        size === 'md' ? 'border border-neutral-200 bg-neutral-100' : 'bg-bg',
      )}
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
              'cursor-pointer whitespace-nowrap rounded-pill border-none text-center font-body transition-colors',
              fullWidth && 'flex-1',
              size === 'md' ? 'px-lg py-[9px] text-label' : 'px-md py-[7px] text-caption',
              active
                ? 'bg-accent font-semibold text-bg'
                : cn(
                    'bg-transparent hover:bg-accent-100',
                    size === 'md' ? 'font-semibold text-text' : 'text-neutral-700',
                  ),
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
