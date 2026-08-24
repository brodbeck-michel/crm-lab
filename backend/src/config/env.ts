/**
 * Carregamento e validacao das variaveis de ambiente (zod).
 *
 * Regras:
 * - Falha rapido e com mensagem clara: se algo essencial faltar em producao o
 *   processo nao sobe.
 * - Em `development`/`test` valores default sao aceitos para que o repo rode
 *   sem `.env`.
 * - NUNCA logue o objeto `env` inteiro: ele contem segredos. Use `safeEnv()`.
 *
 * Toda chave nova precisa entrar tambem em `backend/.env.example`
 * (CONVENTIONS.md "Variaveis de Ambiente").
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/config -> backend/.env  (e dist/backend/src/config -> ... tratado pelo cwd)
dotenv.config({ path: path.resolve(here, '../../.env') });
dotenv.config();

/** Trata string vazia como "nao informado" — `.env.example` traz chaves vazias. */
const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional(),
);

const numberFrom = (fallback: number) =>
  z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }, z.number().int().positive());

/** Igual a `numberFrom`, mas aceita 0 (usado por `TRUST_PROXY_HOPS`). */
const nonNegativeNumberFrom = (fallback: number) =>
  z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }, z.number().int().min(0).max(10));

const DEV_JWT_SECRET = 'dev-only-insecure-jwt-secret';
const DEV_JWT_REFRESH_SECRET = 'dev-only-insecure-jwt-refresh-secret';

/** Valores do `.env.example` que NAO podem ir para producao. */
const PLACEHOLDER_SECRETS = new Set([
  'troque-este-valor-em-producao',
  'troque-este-valor-tambem',
  DEV_JWT_SECRET,
  DEV_JWT_REFRESH_SECRET,
]);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: numberFrom(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: optionalString,
    REDIS_URL: optionalString,

    JWT_SECRET: optionalString,
    JWT_REFRESH_SECRET: optionalString,
    JWT_ACCESS_TTL: numberFrom(900),
    JWT_REFRESH_TTL: numberFrom(604800),

    WHATSAPP_API_URL: optionalString,
    WHATSAPP_API_TOKEN: optionalString,
    WHATSAPP_WEBHOOK_SECRET: optionalString,

    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    RATE_LIMIT_PER_MINUTE: numberFrom(100),

    /**
     * Quantos proxies reversos NOSSOS ficam na frente do app (D-057).
     * `0` (default) = nao confia em `X-Forwarded-For` nenhum.
     */
    TRUST_PROXY_HOPS: nonNegativeNumberFrom(0),
    /** Lista de IPs/CIDRs de proxy confiavel. Tem precedencia sobre a contagem. */
    TRUSTED_PROXIES: optionalString,
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return;
    const required: Array<'JWT_SECRET' | 'JWT_REFRESH_SECRET'> = ['JWT_SECRET', 'JWT_REFRESH_SECRET'];
    for (const key of required) {
      const secret = value[key];
      if (!secret) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} e obrigatoria em NODE_ENV=production`,
        });
        continue;
      }
      if (PLACEHOLDER_SECRETS.has(secret)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} ainda usa o valor de exemplo — gere um segredo unico para producao`,
        });
      }
      if (secret.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} precisa de ao menos 32 caracteres em producao`,
        });
      }
    }
    if (!value.DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL e obrigatoria em NODE_ENV=production',
      });
    }
  });

export type RawEnv = z.infer<typeof envSchema>;

export interface Env extends Omit<RawEnv, 'JWT_SECRET' | 'JWT_REFRESH_SECRET'> {
  JWT_SECRET: string;
  JWT_REFRESH_SECRET: string;
  /** true quando o driver de banco deve ser PGlite (D-008). */
  readonly isTest: boolean;
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  /** Origens permitidas no CORS, ja separadas por virgula. */
  readonly corsOrigins: string[];
  /**
   * Valor pronto para `app.set('trust proxy', ...)` (D-057).
   *
   * `false` = nenhum proxy e confiavel, entao `req.ip` e o endereco do socket e
   * `X-Forwarded-For` e ignorado. Este e o DEFAULT: confiar por omissao deixaria
   * rate limit, lockout de login e audit log a merce de um header do cliente.
   */
  readonly trustProxy: number | string[] | false;
}

/**
 * Traduz `TRUSTED_PROXIES` / `TRUST_PROXY_HOPS` para o formato do Express.
 * Lista explicita vence a contagem; sem nenhum dos dois, nao confia em ninguem.
 */
function resolveTrustProxy(value: RawEnv): number | string[] | false {
  const list = (value.TRUSTED_PROXIES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (list.length > 0) return list;
  return value.TRUST_PROXY_HOPS > 0 ? value.TRUST_PROXY_HOPS : false;
}

export class EnvValidationError extends Error {
  constructor(issues: z.ZodIssue[]) {
    const lines = issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    super(`Configuracao de ambiente invalida:\n${lines.join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/** Le e valida `process.env`. Exportado para testes; a app usa a const `env`. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvValidationError(parsed.error.issues);
  }
  const value = parsed.data;
  return {
    ...value,
    JWT_SECRET: value.JWT_SECRET ?? DEV_JWT_SECRET,
    JWT_REFRESH_SECRET: value.JWT_REFRESH_SECRET ?? DEV_JWT_REFRESH_SECRET,
    isTest: value.NODE_ENV === 'test',
    isProduction: value.NODE_ENV === 'production',
    isDevelopment: value.NODE_ENV === 'development',
    corsOrigins: value.CORS_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    trustProxy: resolveTrustProxy(value),
  };
}

/** Versao segura para log/diagnostico — segredos viram `***`. */
export function safeEnv(source: Env = env): Record<string, unknown> {
  const redactedKeys = [
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'DATABASE_URL',
    'REDIS_URL',
    'WHATSAPP_API_TOKEN',
    'WHATSAPP_WEBHOOK_SECRET',
  ];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'function') continue;
    out[key] = redactedKeys.includes(key) && value ? '***' : value;
  }
  return out;
}

export const env: Env = loadEnv();
