import type { UserPresenceStatus } from '@crm-lab/shared';
import { cn } from '@/components/ui/cn';

/** Rótulo de cada status (CRMLAB-120, D-286) — o menu da barra lateral usa os mesmos. */
export const USER_PRESENCE_LABELS: Record<UserPresenceStatus, string> = {
  online: 'Online',
  busy: 'Ocupado',
  away: 'Ausente',
  offline: 'Offline',
};

const DOT_CLASS: Record<UserPresenceStatus, string> = {
  online: 'bg-presence-online',
  busy: 'bg-presence-busy',
  away: 'bg-presence-away',
  offline: 'bg-presence-offline',
};

export interface PresenceDotProps {
  /** `undefined` (lista ainda carregando, pessoa fora da lista) não desenha nada. */
  status: UserPresenceStatus | undefined;
  /** Diâmetro em px. Padrão 10. */
  size?: number;
  className?: string;
}

/**
 * Bolinha de status da atendente (CRMLAB-120, D-286). Sozinha ao lado de um
 * nome, ou no canto do `Avatar` (prop `presence`). A cor nunca é o único
 * sinal: o rótulo vai em `aria-label` e `title`.
 */
export function PresenceDot({ status, size = 10, className }: PresenceDotProps) {
  if (!status) return null;
  const label = USER_PRESENCE_LABELS[status];
  return (
    <span
      role="img"
      aria-label={`Status: ${label}`}
      title={label}
      style={{ width: size, height: size, flex: `0 0 ${size}px` }}
      className={cn('inline-block rounded-pill', DOT_CLASS[status], className)}
    />
  );
}
