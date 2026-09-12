/**
 * Erros de negocio tipados + catalogo completo de `docs/api/API_ERRORS.md`.
 *
 * Services lancam `BusinessError`; o middleware `error-handler` converte para o
 * envelope `ApiErrorBody`. Nunca monte a resposta de erro na mao.
 *
 *   throw new BusinessError('DISCOUNT_EXCEEDS_LIMIT', {
 *     requestedDiscount, userLimit, approvalRequired: true,
 *   });
 */
import type { ApiErrorBody, ApiErrorCode } from '@crm-lab/shared';

export interface ErrorDefinition {
  statusCode: number;
  /** Mensagem pt-BR, amigavel. Pode mudar sem aviso — o contrato e o `code`. */
  message: string;
}

/**
 * `satisfies Record<ApiErrorCode, ErrorDefinition>`: se `ApiErrorCode` ganhar um
 * codigo novo em `shared/types/api.types.ts` e ele nao for mapeado aqui, o
 * typecheck quebra. E isso que garante que o catalogo fica completo.
 */
export const ERROR_CATALOG = {
  // --- Autenticacao & Autorizacao ---
  INVALID_CREDENTIALS: { statusCode: 401, message: 'Credenciais invalidas' },
  TOKEN_EXPIRED: { statusCode: 401, message: 'Sessao expirada' },
  TOKEN_INVALID: { statusCode: 401, message: 'Token invalido' },
  REFRESH_TOKEN_INVALID: { statusCode: 401, message: 'Sessao invalida, faca login novamente' },
  UNAUTHORIZED: { statusCode: 401, message: 'Autenticacao necessaria' },
  FORBIDDEN: { statusCode: 403, message: 'Voce nao tem permissao para esta acao' },
  USER_INACTIVE: { statusCode: 403, message: 'Usuario desativado' },
  TENANT_INACTIVE: { statusCode: 403, message: 'Laboratorio inativo ou suspenso' },

  // --- Recursos ---
  NOT_FOUND: { statusCode: 404, message: 'Recurso nao encontrado' },
  VALIDATION_ERROR: { statusCode: 400, message: 'Dados invalidos' },
  CONFLICT: { statusCode: 409, message: 'Registro ja existente' },

  // --- Propostas ---
  DISCOUNT_EXCEEDS_LIMIT: { statusCode: 403, message: 'Desconto solicitado excede sua alcada' },
  INVALID_STATUS_TRANSITION: { statusCode: 400, message: 'Transicao de estagio nao permitida' },
  LOSS_REASON_REQUIRED: { statusCode: 400, message: 'Informe o motivo da perda' },
  INVALID_LOSS_REASON: { statusCode: 400, message: 'Motivo de perda invalido' },
  PROPOSAL_PENDING_APPROVAL: {
    statusCode: 409,
    message: 'Proposta aguardando aprovacao de desconto',
  },
  PROPOSAL_ALREADY_CLOSED: { statusCode: 409, message: 'Proposta ja encerrada' },
  APPROVAL_NOT_ALLOWED: { statusCode: 403, message: 'Sua alcada nao cobre este desconto' },
  EXAM_NOT_FOUND_OR_INACTIVE: { statusCode: 400, message: 'Exame inexistente ou inativo' },

  // --- Conversas ---
  CONVERSATION_ALREADY_ASSIGNED: {
    statusCode: 409,
    message: 'Conversa ja atribuida a outro atendente',
  },
  CONVERSATION_ARCHIVED: { statusCode: 409, message: 'Conversa arquivada' },
  MESSAGE_SEND_FAILED: { statusCode: 502, message: 'Falha ao enviar a mensagem pelo canal' },

  // --- Canais (Onda 7 — WhatsApp QR) ---
  CHANNEL_QR_UNAVAILABLE: {
    statusCode: 503,
    message: 'Conexao por QR indisponivel: gateway nao configurado',
  },

  // --- Mídia (Onda 8 §4) ---
  MEDIA_TOO_LARGE: { statusCode: 413, message: 'Arquivo excede o tamanho maximo permitido' },

  // --- Vendas — dominio LIS (Onda 9) ---
  SALE_ATTENDANT_NOT_LINKED: {
    statusCode: 403,
    message: 'Seu login nao esta vinculado a um atendente cadastrado',
  },

  // --- Sistema ---
  RATE_LIMIT_EXCEEDED: { statusCode: 429, message: 'Limite de requisicoes excedido' },
  INTERNAL_ERROR: { statusCode: 500, message: 'Erro interno do servidor' },
} satisfies Record<ApiErrorCode, ErrorDefinition>;

export class BusinessError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ApiErrorCode,
    readonly details?: Record<string, unknown>,
  ) {
    const definition = ERROR_CATALOG[code];
    super(definition.message);
    this.name = 'BusinessError';
    this.statusCode = definition.statusCode;
    Error.captureStackTrace?.(this, BusinessError);
  }

  toBody(): ApiErrorBody {
    return toErrorBody(this.code, this.details);
  }
}

export function isBusinessError(err: unknown): err is BusinessError {
  return err instanceof BusinessError;
}

/** Monta o envelope de `API_ERRORS.md` a partir de um codigo. */
export function toErrorBody(
  code: ApiErrorCode,
  details?: Record<string, unknown>,
  messageOverride?: string,
): ApiErrorBody {
  const definition = ERROR_CATALOG[code];
  return {
    error: {
      code,
      message: messageOverride ?? definition.message,
      statusCode: definition.statusCode,
      ...(details !== undefined ? { details } : {}),
    },
  };
}

/** Atalho: recurso inexistente OU de outro tenant — nunca vaze `FORBIDDEN`. */
export function notFound(details?: Record<string, unknown>): BusinessError {
  return new BusinessError('NOT_FOUND', details);
}
