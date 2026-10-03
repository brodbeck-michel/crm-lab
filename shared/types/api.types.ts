/**
 * Tipos transversais da API.
 * Espelha docs/api/API_CONTRACTS.md e docs/contracts/FRONTEND_BACKEND.md.
 * ESTE e o unico lugar que define estes shapes — front e back importam daqui.
 */

/** Meta de paginacao — identica em toda listagem (FRONTEND_BACKEND.md "Paginacao"). */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Envelope generico de listagem. Endpoints concretos usam a chave nomeada (ver D-007). */
export interface Paginated<T> {
  data: T[];
  pagination: PaginationMeta;
}

/** Parametros de paginacao/ordenacao aceitos por toda listagem. */
export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  order?: 'asc' | 'desc';
}

/**
 * Codigos de erro estaveis. Frontend faz switch NESTE valor, nunca na mensagem.
 * Catalogo completo: docs/api/API_ERRORS.md
 */
export type ApiErrorCode =
  // Autenticacao & Autorizacao
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'REFRESH_TOKEN_INVALID'
  | 'FORBIDDEN'
  | 'UNAUTHORIZED'
  | 'USER_INACTIVE'
  | 'TENANT_INACTIVE'
  | 'RESET_TOKEN_INVALID'
  // Recursos
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  // Propostas
  | 'DISCOUNT_EXCEEDS_LIMIT'
  | 'INVALID_STATUS_TRANSITION'
  | 'LOSS_REASON_REQUIRED'
  | 'INVALID_LOSS_REASON'
  | 'PROPOSAL_PENDING_APPROVAL'
  | 'PROPOSAL_ALREADY_CLOSED'
  | 'PROPOSAL_EDIT_NOT_ALLOWED'
  | 'APPROVAL_NOT_ALLOWED'
  | 'EXAM_NOT_FOUND_OR_INACTIVE'
  /** `POST /proposals` com "Criar proposta manualmente no CRM" desligado (CRMLAB-56, D-193). */
  | 'MANUAL_PROPOSAL_DISABLED'
  /** `POST /lis-imports` com "Importação por planilha" desligada (CRMLAB-53, D-189). */
  | 'SPREADSHEET_IMPORT_DISABLED'
  /** `POST /proposals/:id/send` em cartão já enviado ou sendo enviado agora (CRMLAB-58, D-200). */
  | 'PROPOSAL_ALREADY_SENT'
  // Conversas
  | 'CONVERSATION_ALREADY_ASSIGNED'
  | 'CONVERSATION_ARCHIVED'
  | 'MESSAGE_SEND_FAILED'
  // Canais (Onda 7 — WhatsApp QR)
  | 'CHANNEL_QR_UNAVAILABLE'
  | 'CHANNEL_SESSION_STALE'
  // Mídia (Onda 8 §4 — anexo e áudio)
  | 'MEDIA_TOO_LARGE'
  // Vendas — domínio LIS (Onda 9)
  | 'SALE_ATTENDANT_NOT_LINKED'
  // Visitação Médica (CRMLAB-86, D-255)
  /** CRM + UF já usados por outro médico do laboratório (ativo ou inativo). */
  | 'DOCTOR_CRM_ALREADY_EXISTS'
  /** Editar, reagendar ou encerrar visita que já não está `agendada` (CRMLAB-87, D-256). */
  | 'VISIT_ALREADY_CLOSED'
  /** Check-out sem check-in (CRMLAB-88, D-258). */
  | 'VISIT_NOT_CHECKED_IN'
  /** Reagendar visita que já teve check-in (CRMLAB-88, D-258). */
  | 'VISIT_ALREADY_CHECKED_IN'
  // Sistema
  | 'RATE_LIMIT_EXCEEDED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/** Formato padrao de TODA resposta 4xx/5xx (API_ERRORS.md). */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    statusCode: number;
    details?: Record<string, unknown>;
  };
}

/** ISO 8601 UTC no fio — formatacao pt-BR e responsabilidade do frontend. */
export type IsoDateTime = string;
/** Data ISO simples (YYYY-MM-DD). */
export type IsoDate = string;
