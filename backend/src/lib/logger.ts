/**
 * Logger estruturado (pino).
 *
 * Convencao (CONVENTIONS.md "Logs"): o primeiro argumento e o NOME DO EVENTO em
 * dot.notation e o segundo e o contexto estruturado:
 *
 *   logger.info('proposal.created', { proposalId, tenantId, userId });
 *
 * Campos sensiveis sao redigidos automaticamente. NUNCA logue senha, token ou
 * conteudo de mensagem de paciente.
 */
import { pino, type Logger as PinoLogger } from 'pino';
import { env } from '../config/env.js';

/**
 * Exportado só para teste (`tests/kernel/logger-redact.spec.ts`): pino fica
 * `enabled: false` em `NODE_ENV=test` (ver `base` abaixo), então não dá para
 * capturar a SAÍDA redigida de verdade em teste — o teste verifica que o
 * campo está na lista, não o log renderizado.
 */
export const REDACT_PATHS = [
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'Authorization',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.authorization',
  'req.headers.authorization',
  'headers.authorization',
  // CRMLAB-32: o cookie carrega o refresh token em claro no header HTTP.
  'req.headers.cookie',
  'headers.cookie',
  'details.password',
  'details.token',
  // CRMLAB-38 (D-148): redact ampliado — nenhum destes tinha achado real de
  // vazamento (grep vazio no momento do card), mas o proximo
  // `logger.info({ payload })` que incluir um deles vaza sem isto.
  'apikey',
  'apiKey',
  'secret',
  'webhookSecret',
  'contentBase64',
  'email',
  'phone',
  '*.apikey',
  '*.apiKey',
  '*.secret',
  '*.webhookSecret',
  '*.contentBase64',
  '*.email',
  '*.phone',
];

const base = pino({
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  enabled: !env.isTest,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(env.isDevelopment ? {} : {}),
});

export type LogContext = Record<string, unknown>;

/** Interface minima que o kernel expoe — facilita substituir em teste. */
export interface Logger {
  fatal(event: string, ctx?: LogContext): void;
  error(event: string, ctx?: LogContext): void;
  warn(event: string, ctx?: LogContext): void;
  info(event: string, ctx?: LogContext): void;
  debug(event: string, ctx?: LogContext): void;
  child(bindings: LogContext): Logger;
}

function wrap(instance: PinoLogger): Logger {
  const emit =
    (level: 'fatal' | 'error' | 'warn' | 'info' | 'debug') =>
    (event: string, ctx: LogContext = {}) => {
      instance[level]({ event, ...ctx }, event);
    };
  return {
    fatal: emit('fatal'),
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
    child: (bindings: LogContext) => wrap(instance.child(bindings)),
  };
}

export const logger: Logger = wrap(base);

/** Logger com o correlationId da request ligado (ver request-context.ts). */
export function loggerFor(correlationId: string): Logger {
  return logger.child({ correlationId });
}
