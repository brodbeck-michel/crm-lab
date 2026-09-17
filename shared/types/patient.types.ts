/**
 * Entidade Paciente (D-059) e a tela /patients/:id (PAGES.md §3).
 * Espelha docs/api/API_CONTRACTS.md §2c. ESTE e o unico lugar que define estes shapes.
 *
 * Dinheiro e numero decimal; data e ISO 8601 UTC (string).
 */
import type { IsoDate, IsoDateTime, PaginationMeta, PaginationQuery } from './api.types.js';
import type { ConversationChannel, MessageType, SenderType } from './conversation.types.js';
import type { ProposalStatus } from './proposal.types.js';

/** Cadastro do paciente. Todos os campos de identificacao sao anulaveis: o paciente
 *  nasce de um webhook que so conhece o telefone (D-059). */
export interface Patient {
  id: string;
  /** Telefone e a identidade do paciente no tenant: UNIQUE (tenant_id, phone). */
  phone: string;
  name: string | null;
  email: string | null;
  /** Data de nascimento — data pura, sem hora. */
  birthDate: IsoDate | null;
  /** CPF, so digitos (11 caracteres) quando presente. */
  document: string | null;
  /** Anotacoes internas — NUNCA cliente-facing (BUSINESS_RULES.md §7). */
  notes: string | null;
  tags: string[];
  customFields: Record<string, string>;
  /** Preenchido pelo apagamento LGPD (D-063). Nao-nulo = cadastro anonimizado. */
  anonymizedAt: IsoDateTime | null;
  /** Preenchido por `POST .../inactivate` (D-132). Nao-nulo = paciente inativo. */
  inactivatedAt: IsoDateTime | null;
  /** Motivo da inativacao. So existe enquanto `inactivatedAt` nao-nulo (D-132). */
  inactivationReason: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/**
 * Cadastro + contadores da ficha. Os tres contadores usam o MESMO recorte por papel
 * da listagem (atendente conta so o que enxerga — D-060).
 */
export interface PatientDetail extends Patient {
  conversationCount: number;
  proposalCount: number;
  /** Data da interacao mais recente visivel ao solicitante. */
  lastInteractionAt: IsoDateTime | null;
}

export interface ListPatientsQuery extends PaginationQuery {
  /** Casa nome (full-text 'portuguese'), telefone (so digitos, min. 3) ou documento. */
  search?: string;
  sortBy?: 'name' | 'lastInteractionAt' | 'createdAt' | 'updatedAt';
  /** Default `false`: a listagem esconde paciente inativo (D-132). */
  includeInactive?: boolean;
}

/** Item da listagem: cadastro + a data da ultima interacao (a lista ordena por ela). */
export interface PatientListItem extends Patient {
  lastInteractionAt: IsoDateTime | null;
}

export interface ListPatientsResponse {
  patients: PatientListItem[];
  pagination: PaginationMeta;
}

/**
 * PATCH parcial: campo ausente permanece, `null` apaga.
 * `phone` e editavel desde D-106 — mas nunca apagavel (`string`, sem `| null`): e a
 * chave de deduplicacao do webhook, tem que continuar existindo. Numero ja usado por
 * OUTRO paciente do tenant -> `409 CONFLICT` (`details.reason: "phone_already_in_use"`),
 * nunca funde os dois cadastros.
 */
export interface UpdatePatientRequest {
  phone?: string;
  name?: string | null;
  email?: string | null;
  birthDate?: IsoDate | null;
  document?: string | null;
  notes?: string | null;
  tags?: string[];
  customFields?: Record<string, string>;
}

/* ------------------------------------------------------------------ *
 * Timeline de interacoes — GET /patients/:id/timeline
 * ------------------------------------------------------------------ */

export type PatientTimelineKind =
  | 'conversation_started'
  | 'message'
  | 'proposal_created'
  | 'proposal_stage_changed';

interface PatientTimelineBase {
  /** `<kind>:<uuid da origem>` — estavel e unico dentro da timeline (D-060). */
  id: string;
  kind: PatientTimelineKind;
  at: IsoDateTime;
}

export interface PatientTimelineConversationStarted extends PatientTimelineBase {
  kind: 'conversation_started';
  conversationId: string;
  channel: ConversationChannel;
}

export interface PatientTimelineMessage extends PatientTimelineBase {
  kind: 'message';
  conversationId: string;
  senderType: SenderType;
  senderName: string | null;
  messageType: MessageType;
  /** Conteudo truncado em 160 caracteres pelo backend. */
  preview: string;
}

export interface PatientTimelineProposalCreated extends PatientTimelineBase {
  kind: 'proposal_created';
  proposalId: string;
  status: ProposalStatus;
  discountPercent: number;
  totalPrice: number;
  createdByName: string;
}

export interface PatientTimelineProposalStageChanged extends PatientTimelineBase {
  kind: 'proposal_stage_changed';
  proposalId: string;
  /** `null` na primeira linha do historico (a criacao em `novo_contato`). */
  from: ProposalStatus | null;
  to: ProposalStatus;
  changedByName: string | null;
}

export type PatientTimelineEntry =
  | PatientTimelineConversationStarted
  | PatientTimelineMessage
  | PatientTimelineProposalCreated
  | PatientTimelineProposalStageChanged;

export interface ListPatientTimelineQuery extends PaginationQuery {
  /** Filtra os tipos exibidos. Ausente = todos. */
  kind?: PatientTimelineKind;
  /** Default 'desc' (mais recente primeiro). */
  order?: 'asc' | 'desc';
}

export interface ListPatientTimelineResponse {
  entries: PatientTimelineEntry[];
  pagination: PaginationMeta;
}

/* ------------------------------------------------------------------ *
 * LGPD — GET /patients/:id/export e POST /patients/:id/anonymize
 * ------------------------------------------------------------------ */

/** Dump do titular. Admin apenas; gera audit log `export_patient_data` (D-062). */
export interface PatientExport {
  /** Momento em que a exportacao foi gerada. */
  generatedAt: IsoDateTime;
  patient: Patient;
  conversations: Array<{
    id: string;
    channel: ConversationChannel;
    status: string;
    createdAt: IsoDateTime;
    messages: Array<{
      id: string;
      senderType: SenderType;
      senderName: string | null;
      content: string;
      messageType: MessageType;
      createdAt: IsoDateTime;
    }>;
  }>;
  proposals: Array<{
    id: string;
    status: ProposalStatus;
    discountPercent: number;
    totalPrice: number;
    items: Array<{ examName: string; quantity: number; unitPrice: number }>;
    createdAt: IsoDateTime;
  }>;
}

export interface AnonymizePatientRequest {
  /** Motivo do pedido do titular. 1..500 caracteres. Vai para o audit log. */
  reason: string;
}

/** Cadastro ja anonimizado (D-063). Idempotente: repetir devolve o mesmo estado. */
export interface AnonymizePatientResponse {
  patient: Patient;
  /** Conversas cujas colunas denormalizadas foram limpas na mesma transacao. */
  conversationsAffected: number;
}

/* ------------------------------------------------------------------ *
 * Inativacao — POST /patients/:id/inactivate e /reactivate (D-132)
 * ------------------------------------------------------------------ */

export interface InactivatePatientRequest {
  /** Motivo da inativacao. 1..500 caracteres. Vai para o audit log. */
  reason: string;
}

export interface ReactivatePatientRequest {
  /** Justificativa da reativacao. 1..500 caracteres. Vai para o audit log. */
  reason: string;
}
