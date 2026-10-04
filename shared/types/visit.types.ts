/**
 * Agenda de visitas a médicos solicitantes — CRMLAB-87 (D-256), épico
 * CRMLAB-85 (Visitação Médica). Espelha docs/api/API_CONTRACTS.md §14 e
 * docs/database/SCHEMA.md §36.
 *
 * A visita referencia `Doctor.id` (cadastro do CRMLAB-86, D-255). Reagendar
 * muda a data/hora da MESMA visita e grava o histórico (resposta 6A do épico):
 * não existe status "reagendada".
 */
import type { IsoDateTime } from './api.types.js';
import { isAllowedMediaMimeType, mediaCategoryOf } from './media.types.js';

/** Tipo da visita (como o contato acontece). */
export const VISIT_TYPES = ['presencial', 'online', 'telefone', 'evento'] as const;
export type VisitType = (typeof VISIT_TYPES)[number];

export const VISIT_TYPE_LABELS: Record<VisitType, string> = {
  presencial: 'Presencial',
  online: 'Online',
  telefone: 'Telefone',
  evento: 'Evento',
};

/**
 * `agendada → realizada | cancelada | nao_recebeu`. `realizada` só nasce do
 * check-out (CRMLAB-88, D-258); fora isso a visita sai de `agendada` apenas
 * por cancelar ou "médico não recebeu" (D-256 item 2).
 */
export const VISIT_STATUSES = ['agendada', 'realizada', 'cancelada', 'nao_recebeu'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = {
  agendada: 'Agendada',
  realizada: 'Realizada',
  cancelada: 'Cancelada',
  nao_recebeu: 'Médico não recebeu',
};

/** Estados finais com motivo obrigatório (cancelar / "médico não recebeu"). */
export const VISIT_CLOSING_STATUSES = ['cancelada', 'nao_recebeu'] as const;
export type VisitClosingStatus = (typeof VISIT_CLOSING_STATUSES)[number];

/** Só a visita `agendada` edita, reagenda, cancela ou vira "não recebeu". */
export function isVisitOpen(status: VisitStatus): boolean {
  return status === 'agendada';
}

/**
 * Relato, próximo passo e anexos (CRMLAB-88, D-258 item 6): valem com a visita
 * `agendada` ou `realizada` — o relato costuma vir depois do "Saí".
 */
export function isVisitRecordEditable(status: VisitStatus): boolean {
  return status === 'agendada' || status === 'realizada';
}

export function isVisitType(value: string): value is VisitType {
  return (VISIT_TYPES as readonly string[]).includes(value);
}

export function isVisitStatus(value: string): value is VisitStatus {
  return (VISIT_STATUSES as readonly string[]).includes(value);
}

/** Tamanho máximo do motivo (cancelar, não recebeu, reagendar). */
export const VISIT_REASON_MAX_LENGTH = 500;
/** Tamanho máximo do objetivo/pauta. */
export const VISIT_AGENDA_MAX_LENGTH = 2000;
/** Maior período aceito por `GET /visits` (`to - from`), em dias. */
export const VISIT_LIST_MAX_DAYS = 62;
/** Teto de visitas devolvidas por `GET /visits`; acima disso `truncated: true`. */
export const VISIT_LIST_MAX_RESULTS = 500;
/** Tamanho máximo de cada campo do relato (CRMLAB-88). */
export const VISIT_REPORT_MAX_LENGTH = 4000;
/** Anexos por visita (CRMLAB-88, D-258 item 7). O teto de bytes é o `MAX_MEDIA_BYTES`. */
export const VISIT_ATTACHMENTS_MAX = 20;
/** Tamanho máximo do nome do arquivo anexado. */
export const VISIT_ATTACHMENT_FILE_NAME_MAX_LENGTH = 255;

/**
 * Anexo de visita: só imagem e PDF da allow-list de mídia (CRMLAB-31). Mesma
 * função no formulário e no servidor.
 */
export function isVisitAttachmentMimeType(mimeType: string): boolean {
  if (!isAllowedMediaMimeType(mimeType)) return false;
  const category = mediaCategoryOf(mimeType);
  return category === 'image' || category === 'pdf';
}

/** `'YYYY-MM-DD'` de calendário válido (próximo passo). */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Duração da visita em minutos inteiros (arredondado), do check-in ao
 * check-out. `null` sem os dois.
 */
export function visitDurationMinutes(visit: Pick<Visit, 'checkInAt' | 'checkOutAt'>): number | null {
  if (!visit.checkInAt || !visit.checkOutAt) return null;
  const ms = new Date(visit.checkOutAt).getTime() - new Date(visit.checkInAt).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 60_000));
}

/** Pessoa (usuário do laboratório) exibida na visita. */
export interface VisitPerson {
  id: string;
  name: string;
}

/** Médico da visita — só o que a agenda precisa mostrar. */
export interface VisitDoctor {
  id: string;
  name: string;
  crm: string | null;
  crmUf: string | null;
  specialty: string | null;
  isActive: boolean;
}

export interface Visit {
  id: string;
  doctor: VisitDoctor;
  /** Quem faz a visita. `null` só se o usuário foi apagado (raro; o normal é inativar). */
  responsible: VisitPerson | null;
  /** Data/hora prevista (UTC). Reagendar muda este campo. */
  scheduledAt: IsoDateTime;
  type: VisitType;
  /** Objetivo/pauta. */
  agenda: string | null;
  status: VisitStatus;
  /** Motivo do cancelamento ou do "não recebeu". `null` enquanto `agendada`. */
  statusReason: string | null;
  /** Quando e quem encerrou (cancelou / marcou "não recebeu"). */
  statusChangedAt: IsoDateTime | null;
  statusChangedBy: VisitPerson | null;
  /** Quantas vezes a data já mudou. */
  rescheduleCount: number;
  createdBy: VisitPerson | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** "Cheguei" — hora do servidor (CRMLAB-88). */
  checkInAt: IsoDateTime | null;
  checkInBy: VisitPerson | null;
  /** "Saí" — a visita vira `realizada`. */
  checkOutAt: IsoDateTime | null;
  checkOutBy: VisitPerson | null;
  /** Próximo passo: data de retorno `'YYYY-MM-DD'`. Só sugere a próxima visita. */
  nextVisitDate: string | null;
  attachmentCount: number;
}

/** Relato da visita (CRMLAB-88): três textos opcionais. */
export interface VisitReport {
  /** O que foi apresentado. */
  presented: string | null;
  doctorFeedback: string | null;
  objections: string | null;
}

/** Anexo da visita (imagem ou PDF). Baixa por `GET /visits/:id/attachments/:attachmentId`. */
export interface VisitAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  uploadedBy: VisitPerson | null;
  createdAt: IsoDateTime;
}

/** Uma mudança de data/hora da visita. */
export interface VisitReschedule {
  id: string;
  previousScheduledAt: IsoDateTime;
  newScheduledAt: IsoDateTime;
  reason: string | null;
  changedBy: VisitPerson | null;
  changedAt: IsoDateTime;
}

/** `GET /visits/:id` e respostas de escrita: a visita com o histórico de datas. */
export interface VisitDetail extends Visit {
  /** Mais antigo primeiro. */
  reschedules: VisitReschedule[];
  report: VisitReport;
  /** Mais antigo primeiro. */
  attachments: VisitAttachment[];
}

/**
 * `GET /visits` — período obrigatório `[from, to)` (até `VISIT_LIST_MAX_DAYS`)
 * e filtros opcionais. Sem paginação: a agenda mostra o período inteiro.
 */
export interface ListVisitsQuery {
  from: IsoDateTime;
  to: IsoDateTime;
  doctorId?: string;
  responsibleId?: string;
  status?: VisitStatus;
}

export interface ListVisitsResponse {
  /** Ordem: `scheduledAt` crescente. */
  visits: Visit[];
  /** `true` quando o período tinha mais que `VISIT_LIST_MAX_RESULTS` visitas. */
  truncated: boolean;
}

export interface CreateVisitRequest {
  doctorId: string;
  responsibleId: string;
  scheduledAt: IsoDateTime;
  type: VisitType;
  agenda?: string | null;
}

/**
 * `PATCH /visits/:id` — parcial. A data NÃO muda por aqui
 * (`POST /visits/:id/reschedule`, que grava o histórico).
 */
export interface UpdateVisitRequest {
  doctorId?: string;
  responsibleId?: string;
  type?: VisitType;
  agenda?: string | null;
}

export interface RescheduleVisitRequest {
  scheduledAt: IsoDateTime;
  reason?: string | null;
}

/** Corpo de `POST /visits/:id/cancel` e `POST /visits/:id/not-received`. */
export interface CloseVisitRequest {
  reason: string;
}

/** `PATCH /visits/:id/report` — parcial; `null` (ou só espaço) limpa. */
export interface UpdateVisitReportRequest {
  presented?: string | null;
  doctorFeedback?: string | null;
  objections?: string | null;
  /** `'YYYY-MM-DD'`. */
  nextVisitDate?: string | null;
}

/** `POST /visits/:id/attachments` — base64 em JSON, como o anexo da conversa. */
export interface CreateVisitAttachmentRequest {
  fileName: string;
  mimeType: string;
  contentBase64: string;
}

/** `details` do `409 VISIT_ALREADY_CHECKED_IN` (reagendar depois do check-in). */
export interface VisitCheckedInDetails {
  checkInAt: IsoDateTime;
}

/** `details` do `409 VISIT_ALREADY_CLOSED`. */
export interface VisitClosedDetails {
  status: VisitStatus;
}
