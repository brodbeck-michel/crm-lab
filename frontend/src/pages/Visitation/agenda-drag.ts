import { isVisitOpen, type Visit } from '@crm-lab/shared';
import { FIRST_HOUR } from './agenda-dates';
import { GRID_ROWS } from './agenda-ui';

/**
 * Arrastar para reagendar (CRMLAB-191, D-331) — HTML5 drag-and-drop nativo,
 * o mesmo mecanismo do funil de orçamentos. Sem dependência.
 */

/**
 * Tipo do dado arrastado. No `dragover` o drag data store está em modo
 * protegido (só `types` é legível): é por ele que a grade sabe que é uma visita.
 */
export const VISIT_DRAG_TYPE = 'application/x-crm-visit';

export interface VisitDragPayload {
  id: string;
  /** Distância (px) do topo do cartão até onde ele foi pego — encaixe pelo topo na Semana. */
  grabOffsetY: number;
}

/**
 * Pode pegar: agendada, sem check-in e — para o representante — só a visita
 * em que ele é o responsável. UX apenas: o servidor valida de novo.
 */
export function canDragVisit(visit: Visit, user: { id: string; seesAll: boolean } | null): boolean {
  if (!user || !isVisitOpen(visit.status) || visit.checkInAt !== null) return false;
  return user.seesAll || visit.responsible?.id === user.id;
}

export function isVisitDrag(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(VISIT_DRAG_TYPE);
}

export function startVisitDrag(event: React.DragEvent<HTMLElement>, visit: Visit): void {
  const rect = event.currentTarget.getBoundingClientRect();
  const payload: VisitDragPayload = {
    id: visit.id,
    grabOffsetY: Math.max(0, event.clientY - rect.top),
  };
  event.dataTransfer.setData(VISIT_DRAG_TYPE, JSON.stringify(payload));
  event.dataTransfer.effectAllowed = 'move';
}

/** Lê o dado no `drop` (no `dragover` ele não é legível). `null` se não for uma visita. */
export function readVisitDrag(event: React.DragEvent): VisitDragPayload | null {
  const raw = event.dataTransfer.getData(VISIT_DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      typeof parsed.id === 'string'
    ) {
      const offset = 'grabOffsetY' in parsed ? parsed.grabOffsetY : 0;
      return { id: parsed.id, grabOffsetY: typeof offset === 'number' ? offset : 0 };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Horário de soltura na Semana: `topY` é a posição do TOPO do cartão dentro da
 * coluna (px). Encaixa na meia hora mais próxima, preso em 07:00–20:30.
 */
export function snapToHalfHour(day: Date, topY: number, hourPx: number): Date {
  const halfHours = Math.min(Math.max(Math.round(topY / (hourPx / 2)), 0), GRID_ROWS * 2 - 1);
  const minutes = FIRST_HOUR * 60 + halfHours * 30;
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Math.floor(minutes / 60),
    minutes % 60,
  );
}
