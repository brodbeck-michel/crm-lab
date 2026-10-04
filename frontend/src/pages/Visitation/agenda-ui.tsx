import { useEffect, useState, type ButtonHTMLAttributes } from 'react';
import { VISIT_STATUS_LABELS, type Visit, type VisitStatus } from '@crm-lab/shared';
import { Avatar } from '@/components/shared';
import { cn } from '@/components/ui';
import { FIRST_HOUR, LAST_HOUR, minutesOfDay } from './agenda-dates';

/**
 * Peças visuais da Agenda de visitas (CRMLAB-92, D-262): cores de status,
 * selo, avatar do responsável e o cálculo de posição/sobreposição da grade.
 */

/** Ordem do resumo, dos chips e da barra de distribuição. */
export const STATUS_ORDER: VisitStatus[] = ['agendada', 'realizada', 'nao_recebeu', 'cancelada'];

/** Classes estáticas (o Tailwind só gera o que aparece literal no código). */
export const STATUS_STYLES: Record<
  VisitStatus,
  { bg: string; ink: string; dot: string; border: string }
> = {
  agendada: {
    bg: 'bg-visit-agendada-bg',
    ink: 'text-visit-agendada-ink',
    dot: 'bg-visit-agendada-dot',
    border: 'border-visit-agendada-dot',
  },
  realizada: {
    bg: 'bg-visit-realizada-bg',
    ink: 'text-visit-realizada-ink',
    dot: 'bg-visit-realizada-dot',
    border: 'border-visit-realizada-dot',
  },
  nao_recebeu: {
    bg: 'bg-visit-nao-recebeu-bg',
    ink: 'text-visit-nao-recebeu-ink',
    dot: 'bg-visit-nao-recebeu-dot',
    border: 'border-visit-nao-recebeu-dot',
  },
  cancelada: {
    bg: 'bg-visit-cancelada-bg',
    ink: 'text-visit-cancelada-ink',
    dot: 'bg-visit-cancelada-dot',
    border: 'border-visit-cancelada-dot',
  },
};

/** Cancelada e "não recebeu" — a visita não aconteceu: nome riscado no bloco. */
export function isStruck(status: VisitStatus): boolean {
  return status === 'cancelada' || status === 'nao_recebeu';
}

/** Rótulo curto para chip e selo ("Não recebeu" cabe; o completo vai no `title`). */
export const STATUS_SHORT_LABELS: Record<VisitStatus, string> = {
  ...VISIT_STATUS_LABELS,
  nao_recebeu: 'Não recebeu',
};

export function StatusDot({
  status,
  size = 6,
  className,
}: {
  status: VisitStatus;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block shrink-0 rounded-pill', STATUS_STYLES[status].dot, className)}
      style={{ width: size, height: size }}
    />
  );
}

export function StatusBadge({ status }: { status: VisitStatus }) {
  const style = STATUS_STYLES[status];
  return (
    <span
      title={VISIT_STATUS_LABELS[status]}
      className={cn(
        'inline-flex items-center gap-[6px] whitespace-nowrap rounded-pill px-[10px] py-[4px] text-caption font-semibold leading-none',
        style.bg,
        style.ink,
      )}
    >
      <StatusDot status={status} />
      {STATUS_SHORT_LABELS[status]}
    </span>
  );
}

/** Matizes dos avatares — fora dos de status (25, 75, 250). */
const AVATAR_HUES = [200, 300, 340, 110, 180];

/** Mesma pessoa, mesma cor em qualquer tela: hash estável do id. */
export function avatarHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_HUES[hash % AVATAR_HUES.length] ?? AVATAR_HUES[0]!;
}

export function PersonAvatar({
  person,
  size,
}: {
  person: { id: string; name: string } | null;
  size: number;
}) {
  if (!person) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex shrink-0 items-center justify-center rounded-pill bg-agenda-line-control text-agenda-muted"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
      >
        —
      </span>
    );
  }
  return (
    <Avatar
      name={person.name}
      size={size}
      className="text-bg"
      style={{ backgroundColor: `oklch(0.55 0.11 ${avatarHue(person.id)})` }}
    />
  );
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** "Clínica Vida" — ou, sem clínica no cadastro, o tipo da visita. */
export function visitPlace(visit: Visit, typeLabel: string): string {
  return visit.doctor.clinic ?? typeLabel;
}

/* ------------------------------------------------------------------ */
/* Grade                                                               */
/* ------------------------------------------------------------------ */

/** 1 hora = 64px. A visita não tem duração prevista: o bloco ocupa 1 hora. */
export const HOUR_PX = 64;
export const BLOCK_MINUTES = 60;
export const GRID_ROWS = LAST_HOUR - FIRST_HOUR + 1;
export const GRID_HEIGHT = GRID_ROWS * HOUR_PX;

/** Topo do bloco em px — fora da faixa encaixa na primeira/última linha. */
export function blockTop(date: Date): number {
  const minutes = minutesOfDay(date) - FIRST_HOUR * 60;
  const clamped = Math.min(Math.max(minutes, 0), (GRID_ROWS - 1) * 60);
  return (clamped / 60) * HOUR_PX;
}

export interface PlacedVisit {
  visit: Visit;
  top: number;
  lane: number;
}

/**
 * Sobreposição: cada visita vai para a primeira "lane" livre (a anterior já
 * terminou). As lanes recuam 28% em vez de dividir a coluna.
 */
export function placeVisits(visits: Visit[]): PlacedVisit[] {
  const sorted = [...visits].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const laneEnds: number[] = [];
  return sorted.map((visit) => {
    const top = blockTop(new Date(visit.scheduledAt));
    let lane = laneEnds.findIndex((end) => end <= top);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = top + (BLOCK_MINUTES / 60) * HOUR_PX;
    return { visit, top, lane };
  });
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

/** `matchMedia` reativo. Sem `matchMedia` (testes), devolve `fallback`. */
export function useMediaQuery(query: string, fallback = false): boolean {
  const get = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : fallback;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, [query]);
  return matches;
}

/** "Agora", atualizado a cada minuto — linha do horário atual. */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/* ------------------------------------------------------------------ */
/* Botões da Agenda — raio de cartão (md) em vez da pílula do app       */
/* ------------------------------------------------------------------ */

type AgendaButtonVariant = 'primary' | 'secondary' | 'danger';

const AGENDA_BUTTON: Record<AgendaButtonVariant, string> = {
  primary: 'border-transparent bg-accent text-bg hover:bg-accent-600',
  secondary: 'border-agenda-line-control bg-bg text-agenda-ink hover:bg-agenda-press',
  danger: 'border-agenda-line-control bg-bg text-agenda-danger hover:bg-agenda-press',
};

export function AgendaButton({
  variant = 'secondary',
  className,
  loading,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: AgendaButtonVariant; loading?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex min-h-[40px] items-center justify-center gap-sm rounded-md border px-md text-[14px] font-semibold transition-colors',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-50',
        AGENDA_BUTTON[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}
