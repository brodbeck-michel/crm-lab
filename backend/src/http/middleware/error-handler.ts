/**
 * Conversor unico de excecao -> envelope `ApiErrorBody` (docs/api/API_ERRORS.md).
 * DEVE ser o ultimo middleware registrado em `createApp`.
 *
 * Classes tratadas:
 *   BusinessError -> code/statusCode/details do proprio erro
 *   ZodError      -> VALIDATION_ERROR com `details.fields: { campo: motivo }`
 *   desconhecido  -> INTERNAL_ERROR, logado com correlationId, SEM stack na resposta
 */
import type { ErrorRequestHandler, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@crm-lab/shared';
import { BusinessError, toErrorBody } from '../errors.js';
import { requestLogger } from './request-context.js';

/** `{ 'items.0.quantity': 'Numero obrigatorio' }` — shape esperado pelo frontend. */
export function zodFieldErrors(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_root';
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

export function toApiErrorBody(err: unknown): { status: number; body: ApiErrorBody } {
  if (err instanceof BusinessError) {
    return { status: err.statusCode, body: err.toBody() };
  }
  if (err instanceof ZodError) {
    const body = toErrorBody('VALIDATION_ERROR', { fields: zodFieldErrors(err) });
    return { status: body.error.statusCode, body };
  }
  const body = toErrorBody('INTERNAL_ERROR');
  return { status: body.error.statusCode, body };
}

export function errorHandler(): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, _next): void => {
    const { status, body } = toApiErrorBody(err);
    const log = requestLogger(req);

    if (body.error.code === 'INTERNAL_ERROR') {
      // Stack fica SO no log — nunca na resposta (API_ERRORS.md "Sistema").
      log.error('http.unhandled_error', {
        method: req.method,
        path: req.originalUrl,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    } else {
      log.warn('http.business_error', {
        method: req.method,
        path: req.originalUrl,
        code: body.error.code,
        statusCode: status,
      });
    }

    if (res.headersSent) return;
    res.status(status).json(body);
  };
}

/** 404 padrao para rota inexistente — mantem o envelope do catalogo. */
export function notFoundHandler(): import('express').RequestHandler {
  return (_req, res): void => {
    const body = toErrorBody('NOT_FOUND');
    res.status(body.error.statusCode).json(body);
  };
}
