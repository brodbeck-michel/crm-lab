import type { ToastOptions } from '@/components/ui';
import { ApiError, isApiError } from './client';

/**
 * Tratamento GENÉRICO de erro — o `switch (error.code)` de
 * docs/api/API_ERRORS.md ("Tratamento no Frontend").
 *
 * Este é o ÚNICO lugar de tratamento genérico. Casos específicos
 * (ex.: `DISCOUNT_EXCEEDS_LIMIT` no form de orçamento) são tratados no
 * componente, sempre por CÓDIGO — nunca por mensagem.
 */

export type ToastFn = (message: string, options?: ToastOptions) => unknown;

export interface ErrorHandlerDeps {
  toast: ToastFn;
  /** Limpa a sessão e leva para `/login`. */
  redirectToLogin: () => void;
}

/** Resultado do tratamento — o form usa `fieldErrors` para marcar os campos. */
export interface HandledApiError {
  error: ApiError;
  /** Preenchido só em `VALIDATION_ERROR`: `{ campo: motivo }`. */
  fieldErrors?: Record<string, string>;
  /** `true` quando o erro já foi resolvido de forma transparente pelo client. */
  handledSilently: boolean;
}

/** `details.fields` → `{ campo: motivo }` (API_ERRORS.md — VALIDATION_ERROR). */
export function mapFieldErrors(details: Record<string, unknown> | undefined): Record<string, string> {
  const fields = details?.fields;
  if (!fields || typeof fields !== 'object') return {};
  const mapped: Record<string, string> = {};
  for (const [field, reason] of Object.entries(fields as Record<string, unknown>)) {
    mapped[field] = typeof reason === 'string' ? reason : String(reason);
  }
  return mapped;
}

function retryAfterMessage(details: Record<string, unknown> | undefined): string {
  const retryAfter = details?.retryAfter;
  const seconds = typeof retryAfter === 'number' ? retryAfter : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) {
    return `Muitas requisições. Tente novamente em ${Math.ceil(seconds)}s.`;
  }
  return 'Muitas requisições. Aguarde um instante e tente novamente.';
}

/** Erro desconhecido (rede, parse) vira um `ApiError` de sistema. */
/** Mesmo texto do `WHATSAPP_WINDOW_CLOSED` do backend (API_ERRORS.md), com acento. */
export const WINDOW_CLOSED_MESSAGE =
  'A janela de 24 horas do WhatsApp está fechada: o paciente não escreve há mais de 24 h. ' +
  'Fora dela só é possível enviar template aprovado.';

/**
 * CRMLAB-148 (D-320): conversa de balcão/site que já recebeu mensagem do
 * paciente pelo WhatsApp. Responder nela não chegaria ao paciente.
 */
export const CHANNEL_NOT_WHATSAPP_MESSAGE =
  'Esta conversa não é de WhatsApp, mas o paciente escreveu por lá: a resposta não chegaria a ele. ' +
  'Use "Nova conversa" com o telefone do paciente para responder pelo WhatsApp.';

export function isChannelNotWhatsApp(error: ApiError): boolean {
  return error.code === 'CONFLICT' && error.details?.reason === 'channel_not_whatsapp';
}

/**
 * Texto do `FIRST_CONTACT_LIMIT_REACHED` (CRMLAB-134, D-306): quantos por
 * hora, a partir de que horas abre vaga e o que fazer no lugar.
 */
export function firstContactLimitMessage(details: Record<string, unknown> | undefined): string {
  const limit = typeof details?.limit === 'number' ? details.limit : null;
  const retryAt = typeof details?.retryAt === 'string' ? new Date(details.retryAt) : null;
  const when =
    retryAt && !Number.isNaN(retryAt.getTime())
      ? ` Próxima vaga às ${retryAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.`
      : '';
  const head =
    limit !== null
      ? `Limite de ${limit} primeiros contatos por hora no WhatsApp atingido.`
      : 'Limite de primeiros contatos por hora no WhatsApp atingido.';
  return `${head}${when} Peça ao paciente que mande uma mensagem primeiro: aí o envio é liberado.`;
}

export function toHandledError(error: unknown): ApiError {
  if (isApiError(error)) return error;
  const message = error instanceof Error ? error.message : 'Erro inesperado';
  return new ApiError('INTERNAL_ERROR', message, 0);
}

export function createApiErrorHandler(deps: ErrorHandlerDeps) {
  return function handleApiError(unknownError: unknown): HandledApiError {
    const error = toHandledError(unknownError);

    switch (error.code) {
      case 'TOKEN_EXPIRED':
        // `client.ts` já renovou e repetiu a original de forma transparente.
        // Se chegou aqui, o retry também falhou: não há o que mostrar.
        return { error, handledSilently: true };

      case 'REFRESH_TOKEN_INVALID':
      case 'TOKEN_INVALID':
      case 'UNAUTHORIZED':
        deps.redirectToLogin();
        return { error, handledSilently: true };

      case 'RATE_LIMIT_EXCEEDED':
        deps.toast(retryAfterMessage(error.details), { tone: 'attention' });
        return { error, handledSilently: false };

      case 'FIRST_CONTACT_LIMIT_REACHED':
        deps.toast(firstContactLimitMessage(error.details), { tone: 'attention' });
        return { error, handledSilently: false };

      case 'WHATSAPP_WINDOW_CLOSED':
        deps.toast(WINDOW_CLOSED_MESSAGE, { tone: 'attention' });
        return { error, handledSilently: false };

      case 'CONFLICT':
        deps.toast(isChannelNotWhatsApp(error) ? CHANNEL_NOT_WHATSAPP_MESSAGE : error.message, {
          tone: 'attention',
        });
        return { error, handledSilently: false };

      case 'VALIDATION_ERROR': {
        const fieldErrors = mapFieldErrors(error.details);
        if (Object.keys(fieldErrors).length === 0) {
          deps.toast(error.message, { tone: 'attention' });
        }
        return { error, fieldErrors, handledSilently: false };
      }

      default:
        deps.toast(error.message, { tone: 'attention' });
        return { error, handledSilently: false };
    }
  };
}

export type ApiErrorHandler = ReturnType<typeof createApiErrorHandler>;
