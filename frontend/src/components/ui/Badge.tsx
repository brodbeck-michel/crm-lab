import { cn } from './cn';

export interface BadgeProps {
  /** Contagem (não lidas). `0` não renderiza nada. */
  count: number;
  /** Acima disso mostra "N+". Padrão 99. */
  max?: number;
  /** Rótulo acessível — ex.: "3 mensagens não lidas". */
  label?: string;
}

/**
 * Círculo accent-2 com contagem de não lidas.
 * `flex: 0 0 auto` + min-width: nunca é comprimido em lista apertada.
 */
export function Badge({ count, max = 99, label }: BadgeProps) {
  if (count <= 0) return null;

  return (
    <span
      aria-label={label}
      className={cn(
        'inline-flex h-[20px] min-w-[20px] flex-[0_0_auto] items-center justify-center',
        'rounded-pill bg-accent2 px-[6px] font-body text-micro font-bold tracking-normal text-bg',
      )}
    >
      {count > max ? `${max}+` : count}
    </span>
  );
}
