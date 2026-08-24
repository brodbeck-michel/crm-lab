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
