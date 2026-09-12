import type { LisBudgetAgeBand } from '@crm-lab/shared';
import { cn } from '@/components/ui/cn';

export interface AgeBadgeProps {
  daysOpen: number;
  ageBand: LisBudgetAgeBand;
}

/**
 * Tom crescente de urgência por faixa (`docs/frontend/COMPONENTS.md`) — o
 * NÚMERO de dias sempre acompanha a cor (D5: nunca só cor carrega o
 * significado).
 */
const TONE: Record<LisBudgetAgeBand, string> = {
  '0-7': 'bg-neutral-200 text-neutral-800',
  '8-15': 'bg-accent-200 text-accent-800',
  '16-30': 'bg-accent-300 text-accent-900',
  '30+': 'bg-accent-500 text-bg',
};

export function AgeBadge({ daysOpen, ageBand }: AgeBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-xs rounded-full px-md py-xs font-body text-caption font-semibold whitespace-nowrap',
        TONE[ageBand],
      )}
    >
      {daysOpen} {daysOpen === 1 ? 'dia' : 'dias'} · {ageBand}
    </span>
  );
}
