import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from './cn';

export type TooltipPlacement = 'top' | 'bottom';

export interface TooltipProps {
  /** Texto curto. Tooltip não carrega conteúdo essencial nem interativo. */
  content: string;
  placement?: TooltipPlacement;
  children: ReactNode;
}

/**
 * Dica em hover e em foco de teclado (nunca só hover — foco também revela).
 * O gatilho é envolvido por um `<span>` inline; posicionamento é absoluto
 * em relação a ele.
 */
export function Tooltip({ content, placement = 'top', children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? tooltipId : undefined} className="inline-flex">
        {children}
      </span>

      {open && (
        <span
          role="tooltip"
          id={tooltipId}
          className={cn(
            'pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap',
            'rounded-md bg-neutral-900 px-sm py-xs font-body text-caption text-bg shadow-md',
            placement === 'top' ? 'bottom-full mb-xs' : 'top-full mt-xs',
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
