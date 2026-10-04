/**
 * Linha do tempo do médico — CRMLAB-89 (D-261), card [D] do épico CRMLAB-85
 * (Visitação Médica). Espelha docs/api/API_CONTRACTS.md §13 ("Linha do tempo")
 * e docs/database/SCHEMA.md §38.
 *
 * A linha do tempo junta, na leitura, as **visitas** do médico
 * (`doctor_visits`) e os **registros lançados à mão** (`doctor_interactions`:
 * ligação, e-mail, WhatsApp). Não puxa as conversas do WhatsApp do CRM —
 * não existe ligação conversa ↔ médico (resposta 8 do épico).
 */
import type { IsoDateTime } from './api.types.js';
import type { VisitPerson, VisitStatus, VisitType } from './visit.types.js';

/** Como o contato aconteceu (registro manual). */
export const DOCTOR_INTERACTION_TYPES = ['ligacao', 'email', 'whatsapp'] as const;
export type DoctorInteractionType = (typeof DOCTOR_INTERACTION_TYPES)[number];

export const DOCTOR_INTERACTION_TYPE_LABELS: Record<DoctorInteractionType, string> = {
  ligacao: 'Ligação',
  email: 'E-mail',
  whatsapp: 'WhatsApp',
};

export function isDoctorInteractionType(value: string): value is DoctorInteractionType {
  return (DOCTOR_INTERACTION_TYPES as readonly string[]).includes(value);
}

/** Tamanho máximo da descrição do registro manual. */
export const DOCTOR_INTERACTION_DESCRIPTION_MAX_LENGTH = 2000;

/**
 * Folga para o relógio do aparelho: `occurredAt` até 5 min no futuro ainda
 * vale ("agora" digitado num celular adiantado). Mais que isso é erro.
 */
export const DOCTOR_INTERACTION_FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Itens por página da linha do tempo (`limit`). */
export const DOCTOR_TIMELINE_DEFAULT_LIMIT = 20;
export const DOCTOR_TIMELINE_MAX_LIMIT = 50;

/** Tamanho máximo do trecho do relato mostrado na linha do tempo. */
export const DOCTOR_TIMELINE_EXCERPT_MAX_LENGTH = 280;

/** Registro de interação lançado à mão na ficha do médico. */
export interface DoctorInteraction {
  id: string;
  doctorId: string;
  type: DoctorInteractionType;
  /** Quando a interação aconteceu (informado por quem lançou). */
  occurredAt: IsoDateTime;
  description: string;
  /** Quem lançou. `null` só se o usuário foi apagado. */
  createdBy: VisitPerson | null;
  /** Quem editou por último. `null` = nunca editado. */
  updatedBy: VisitPerson | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Visita do médico vista na linha do tempo — resumo, a visita inteira abre na Agenda. */
export interface DoctorTimelineVisit {
  kind: 'visit';
  /** Id da visita (`GET /visits/:id`). */
  id: string;
  /** Posição na linha do tempo: o check-in, ou a data prevista se não houve check-in. */
  occurredAt: IsoDateTime;
  status: VisitStatus;
  type: VisitType;
  scheduledAt: IsoDateTime;
  checkInAt: IsoDateTime | null;
  checkOutAt: IsoDateTime | null;
  /** Quem faz a visita. */
  responsible: VisitPerson | null;
  /** Motivo de `cancelada` / `nao_recebeu`. */
  statusReason: string | null;
  /**
   * Primeiro trecho preenchido do relato (apresentado → feedback → objeções),
   * cortado em `DOCTOR_TIMELINE_EXCERPT_MAX_LENGTH`. `null` sem relato.
   */
  reportExcerpt: string | null;
  attachmentCount: number;
}

export interface DoctorTimelineInteraction extends DoctorInteraction {
  kind: 'interaction';
}

export type DoctorTimelineItem = DoctorTimelineVisit | DoctorTimelineInteraction;

/**
 * `GET /doctors/:id/timeline` — do mais novo para o mais antigo. Carregamento
 * sob demanda por cursor: `cursor` é o `nextCursor` da página anterior.
 */
export interface DoctorTimelineQuery {
  limit?: number;
  cursor?: string;
}

export interface DoctorTimelineResponse {
  items: DoctorTimelineItem[];
  /** `null` = não há mais itens. Opaco: mande de volta como `cursor`. */
  nextCursor: string | null;
}

/** `POST /doctors/:id/interactions`. */
export interface CreateDoctorInteractionRequest {
  type: DoctorInteractionType;
  occurredAt: IsoDateTime;
  description: string;
}

/** `PATCH /doctors/:id/interactions/:interactionId` — parcial. */
export type UpdateDoctorInteractionRequest = Partial<CreateDoctorInteractionRequest>;
