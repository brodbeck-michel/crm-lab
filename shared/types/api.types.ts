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
  | 'APPROVAL_NOT_ALLOWED'
  | 'EXAM_NOT_FOUND_OR_INACTIVE'
  // Conversas
  | 'CONVERSATION_ALREADY_ASSIGNED'
  | 'CONVERSATION_ARCHIVED'
  | 'MESSAGE_SEND_FAILED'
  // Canais (Onda 7 — WhatsApp QR)
  | 'CHANNEL_QR_UNAVAILABLE'
  // Sistema
  | 'RATE_LIMIT_EXCEEDED'
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
