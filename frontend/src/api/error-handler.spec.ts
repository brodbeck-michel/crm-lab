import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { createApiErrorHandler, mapFieldErrors } from './error-handler';

/** O `switch (error.code)` de docs/api/API_ERRORS.md — "Tratamento no Frontend". */

let toast: ReturnType<typeof vi.fn>;
let redirectToLogin: ReturnType<typeof vi.fn>;
let handle: ReturnType<typeof createApiErrorHandler>;

beforeEach(() => {
  toast = vi.fn();
  redirectToLogin = vi.fn();
  handle = createApiErrorHandler({ toast, redirectToLogin });
});

describe('error-handler', () => {
  it('REFRESH_TOKEN_INVALID → login, sem toast', () => {
    handle(new ApiError('REFRESH_TOKEN_INVALID', 'Sessão expirada', 401));

    expect(redirectToLogin).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('TOKEN_EXPIRED que chegou até aqui é silencioso (o client já tentou refresh)', () => {
    const result = handle(new ApiError('TOKEN_EXPIRED', 'Token expirado', 401));

    expect(result.handledSilently).toBe(true);
    expect(toast).not.toHaveBeenCalled();
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  it('RATE_LIMIT_EXCEEDED → toast com o retryAfter', () => {
    handle(
      new ApiError('RATE_LIMIT_EXCEEDED', 'Limite atingido', 429, { retryAfter: 30 }),
    );

    expect(toast).toHaveBeenCalledWith(
      'Muitas requisições. Tente novamente em 30s.',
      { tone: 'attention' },
    );
  });

  it('VALIDATION_ERROR → mapeia details.fields e NÃO abre toast', () => {
    const result = handle(
      new ApiError('VALIDATION_ERROR', 'DTO inválido', 400, {
        fields: { email: 'formato inválido', password: 'mínimo 8 caracteres' },
      }),
    );

    expect(result.fieldErrors).toEqual({
      email: 'formato inválido',
      password: 'mínimo 8 caracteres',
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it('VALIDATION_ERROR sem fields cai no toast da mensagem', () => {
    handle(new ApiError('VALIDATION_ERROR', 'Requisição inválida', 400));
    expect(toast).toHaveBeenCalledWith('Requisição inválida', { tone: 'attention' });
  });

  it('default → toast com a mensagem do servidor', () => {
    handle(new ApiError('CONVERSATION_ALREADY_ASSIGNED', 'Conversa já atribuída', 409));
    expect(toast).toHaveBeenCalledWith('Conversa já atribuída', { tone: 'attention' });
  });

  it('erro que não é ApiError (rede) vira INTERNAL_ERROR tratável', () => {
    const result = handle(new Error('Failed to fetch'));

    expect(result.error.code).toBe('INTERNAL_ERROR');
    expect(toast).toHaveBeenCalledWith('Failed to fetch', { tone: 'attention' });
  });

  it('mapFieldErrors tolera details ausente', () => {
    expect(mapFieldErrors(undefined)).toEqual({});
    expect(mapFieldErrors({})).toEqual({});
  });
});
