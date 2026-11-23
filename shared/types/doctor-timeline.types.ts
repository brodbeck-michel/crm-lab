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
import type { UserRole } from './auth.types.js';
import type { VisitAttachment, VisitPerson, VisitReport, VisitStatus, VisitType } from './visit.types.js';
import type { VisitPurposeRef } from './visit-purpose.types.js';

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

/**
 * Filtro do feed por tipo (CRMLAB-192, D-332): `visita` + os tipos de registro
 * manual. Vai no fio como `?types=visita,ligacao` (separado por vírgula).
 */
export const DOCTOR_TIMELINE_FILTERS = ['visita', ...DOCTOR_INTERACTION_TYPES] as const;
export type DoctorTimelineFilter = (typeof DOCTOR_TIMELINE_FILTERS)[number];

export const DOCTOR_TIMELINE_FILTER_LABELS: Record<DoctorTimelineFilter, string> = {
  visita: 'Visitas',
  ligacao: 'Ligações',
  whatsapp: 'WhatsApp',
  email: 'E-mail',
};

export function isDoctorTimelineFilter(value: string): value is DoctorTimelineFilter {
  return (DOCTOR_TIMELINE_FILTERS as readonly string[]).includes(value);
}

/** Comentários (CRMLAB-192, D-332). */
export const DOCTOR_TIMELINE_COMMENT_MAX_LENGTH = 2000;
/** Teto por item: os comentários vêm embutidos no item da página. */
export const DOCTOR_TIMELINE_COMMENTS_PER_ITEM_MAX = 100;

/** Espécie do item comentado — o mesmo `kind` do item da linha do tempo. */
export const DOCTOR_TIMELINE_ITEM_KINDS = ['visit', 'interaction'] as const;
export type DoctorTimelineItemKind = (typeof DOCTOR_TIMELINE_ITEM_KINDS)[number];

/** Comentário num item da linha do tempo (visita ou registro manual). */
export interface DoctorTimelineComment {
  id: string;
  itemKind: DoctorTimelineItemKind;
  itemId: string;
  body: string;
  /** `null` só se o usuário foi apagado. */
  author: VisitPerson | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Última edição do texto. `null` = nunca editado. */
  editedAt: IsoDateTime | null;
}

/** `POST /doctors/:id/comments`. */
export interface CreateDoctorTimelineCommentRequest {
  itemKind: DoctorTimelineItemKind;
  itemId: string;
  body: string;
}

/** `PATCH /doctors/:id/comments/:commentId`. */
export interface UpdateDoctorTimelineCommentRequest {
  body: string;
}

/**
 * Quem mexe no comentário (D-332 item 5): só o autor edita; o autor e o admin
 * excluem. Mesma regra no backend (que recusa) e na tela (que esconde).
 */
export function doctorTimelineCommentPermissions(
  comment: Pick<DoctorTimelineComment, 'author'>,
  user: { id: string; role: UserRole },
): { canEdit: boolean; canDelete: boolean } {
  const isAuthor = comment.author !== null && comment.author.id === user.id;
  return { canEdit: isAuthor, canDelete: isAuthor || user.role === 'admin' };
}

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
  /** Finalidade da visita (CRMLAB-190, D-330). */
  purpose: VisitPurposeRef;
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
  /** Relato inteiro (CRMLAB-192, D-332). */
  report: VisitReport;
  /** Data de retorno `'YYYY-MM-DD'`. */
  nextVisitDate: string | null;
  /** Mais antigo primeiro. Baixa por `GET /visits/:id/attachments/:attachmentId`. */
  attachments: VisitAttachment[];
  /** Mais antigo primeiro (D-332). */
  comments: DoctorTimelineComment[];
}

export interface DoctorTimelineInteraction extends DoctorInteraction {
  kind: 'interaction';
  /** Mais antigo primeiro (D-332). */
  comments: DoctorTimelineComment[];
}

export type DoctorTimelineItem = DoctorTimelineVisit | DoctorTimelineInteraction;

/**
 * `GET /doctors/:id/timeline` — do mais novo para o mais antigo. Carregamento
 * sob demanda por cursor: `cursor` é o `nextCursor` da página anterior.
 */
export interface DoctorTimelineQuery {
  limit?: number;
  cursor?: string;
  /** Filtro por tipo (D-332). Ausente/vazio = tudo. No fio: separado por vírgula. */
  types?: DoctorTimelineFilter[];
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
