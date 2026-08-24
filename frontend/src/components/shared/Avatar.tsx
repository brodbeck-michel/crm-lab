import { initials } from '@/lib/format';
import { cn } from '@/components/ui/cn';

export interface AvatarProps {
  /** Nome completo — as iniciais saem de `initials()` em lib/format. */
  name: string;
  /** Lado do círculo em px. Padrão 36 (item de conversa). */
  size?: number;
}

/**
 * Círculo com iniciais, fundo accent-2-200.
 *
 * SEMPRE `flex: 0 0 <size>` — em container apertado o avatar não pode ser
 * comprimido em elipse (regra de largura 2 de COMPONENTS.md).
 */
export function Avatar({ name, size = 36 }: AvatarProps) {
  return (
    <span
      title={name}
      aria-hidden="true"
      style={{ width: size, height: size, flex: `0 0 ${size}px`, fontSize: Math.round(size * 0.36) }}
      className={cn(
        'inline-flex items-center justify-center rounded-pill',
        'bg-accent2-200 font-body font-bold uppercase leading-none text-accent2-800',
      )}
    >
      {initials(name)}
    </span>
  );
}
