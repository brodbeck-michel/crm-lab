import type { CSSProperties } from 'react';
import type { UserPresenceStatus } from '@crm-lab/shared';
import { initials } from '@/lib/format';
import { cn } from '@/components/ui/cn';
import { PresenceDot } from './PresenceDot';

export interface AvatarProps {
  /** Nome completo — as iniciais saem de `initials()` em lib/format. */
  name: string;
  /** Lado do círculo em px. Padrão 36 (item de conversa). */
  size?: number;
  /**
   * Sobrepõe fundo e cor das iniciais (CRMLAB-81): a lista do Atendimento usa
   * `bg-chat-avatar text-chat-avatar-text`. Sem ele, accent-2-200/800.
   */
  className?: string;
  /** Cor calculada em runtime (avatar do responsável na Agenda, CRMLAB-92). */
  style?: CSSProperties;
  /**
   * Status da atendente (CRMLAB-120, D-286): bolinha no canto inferior
   * direito, com borda da cor da superfície para destacar do avatar.
   */
  presence?: UserPresenceStatus;
}

/**
 * Círculo com iniciais, fundo accent-2-200.
 *
 * SEMPRE `flex: 0 0 <size>` — em container apertado o avatar não pode ser
 * comprimido em elipse (regra de largura 2 de COMPONENTS.md).
 */
export function Avatar({ name, size = 36, className, style, presence }: AvatarProps) {
  const circle = (
    <span
      title={name}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        fontSize: Math.round(size * 0.36),
        ...style,
      }}
      className={cn(
        'inline-flex items-center justify-center rounded-pill',
        'font-body font-bold uppercase leading-none',
        className ?? 'bg-accent2-200 text-accent2-800',
      )}
    >
      {initials(name)}
    </span>
  );
  if (!presence) return circle;

  const dot = Math.max(8, Math.round(size * 0.3));
  return (
    <span className="relative inline-flex" style={{ flex: `0 0 ${size}px` }}>
      {circle}
      <PresenceDot
        status={presence}
        size={dot}
        className="absolute bottom-0 right-0 border-2 border-surface"
      />
    </span>
  );
}
