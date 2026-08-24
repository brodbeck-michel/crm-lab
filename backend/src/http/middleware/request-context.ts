/**
 * Gera um correlationId por request e o disponibiliza para o logger e para o
 * error-handler. Vai tambem no header `X-Correlation-Id` da resposta, para que
 * o suporte consiga cruzar um erro reportado com a linha de log.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { loggerFor, type Logger } from '../../lib/logger.js';

export const CORRELATION_HEADER = 'x-correlation-id';

const loggers = new WeakMap<Request, Logger>();

export function requestContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.headers[CORRELATION_HEADER];
    const correlationId =
      typeof incoming === 'string' && incoming.trim().length > 0 ? incoming.trim() : randomUUID();

    req.correlationId = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);
    loggers.set(req, loggerFor(correlationId));
    next();
  };
}

/** Logger ja ligado ao correlationId da request. */
export function requestLogger(req: Request): Logger {
  return loggers.get(req) ?? loggerFor(req.correlationId ?? 'no-correlation-id');
}
