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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
// Em `test` o `.env` da MAQUINA nao entra: a suite afirma o comportamento
// PADRAO (`RATE_LIMIT_PER_MINUTE` = 100, gateway Evolution ausente ->
// CHANNEL_QR_UNAVAILABLE) e um valor local preenchido fazia o teste passar ou
// falhar conforme a maquina de quem roda — inclusive verde por ausencia, que e
// o pior dos casos. Teste que precisa de uma variavel a define no proprio
// processo (`process.env.X = ...` no `beforeEach`).
if (process.env.NODE_ENV !== 'test') {
  // src/config -> backend/.env  (e dist/backend/src/config -> ... tratado pelo cwd)
  dotenv.config({ path: path.resolve(here, '../../.env') });
  dotenv.config();
}

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
    /** Teto da FAMÍLIA de refresh (CRMLAB-35, D-154) — 30 dias, não reiniciado a cada rotação. */
    JWT_REFRESH_ABSOLUTE_TTL: numberFrom(30 * 24 * 60 * 60),

    WHATSAPP_API_URL: optionalString,
    WHATSAPP_API_TOKEN: optionalString,
    WHATSAPP_WEBHOOK_SECRET: optionalString,

    /**
     * Gateway Evolution API (self-hosted) para conexao WhatsApp por QR (Onda 7,
     * Bloco B). `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` sao a base e a chave
     * ADMINISTRATIVA do gateway (cria/gerencia instancias); `EVOLUTION_WEBHOOK_TOKEN`
     * e o segredo que o gateway devolve nos webhooks para o CRM, comparado em
     * tempo constante. Qualquer uma ausente => `connectWhatsAppQr` lanca
     * `CHANNEL_QR_UNAVAILABLE` (funcionalidade OPCIONAL — ao contrario do Redis
     * fail-closed de D-058, aqui a ausencia nao derruba o boot).
     */
    EVOLUTION_API_URL: optionalString,
    EVOLUTION_API_KEY: optionalString,
    EVOLUTION_WEBHOOK_TOKEN: optionalString,
    /**
     * Base publica do CRM **vista de dentro do gateway** — e para ca que o
     * Evolution posta os eventos (`<base>/api/v1/webhooks/evolution/<tenantId>`).
     * Nao da para derivar de `CORS_ORIGIN`: aquilo e o endereco do NAVEGADOR, e
     * o gateway roda em outro container (`http://localhost:3000` la dentro
     * aponta para ele mesmo). Ausente = instancia criada sem webhook: o QR
     * pareia, mas nenhuma mensagem entra.
     */
    EVOLUTION_WEBHOOK_BASE_URL: optionalString,

    /**
     * Chave que cifra `tenant_channels.api_token`/`webhook_secret` em repouso
     * (D-076). Vazia em dev/CI = segredo gravado em claro; OBRIGATORIA em
     * producao — sem ela um dump de backup entrega o segredo de HMAC de todos
     * os laboratorios, e o segredo de HMAC e permissao de ESCRITA.
     * Trocar a chave invalida as credenciais ja gravadas.
     */
    CHANNEL_SECRET_KEY: optionalString,

    /**
     * Pasta em disco onde a mídia de mensagem fica gravada (Onda 8 §4.1 — volume
     * local, sem MinIO/S3 nesta onda). Ausente = default por ambiente (dev: pasta
     * `media/` do backend; teste: pasta temporaria do SO, para nao sujar o repo).
     * Obrigatoria em producao pela mesma razao de `CHANNEL_SECRET_KEY`: sem valor
     * explicito, um deploy multi-instancia gravaria cada requisicao num disco
     * diferente e o `GET /media/:id` erraria a instancia certa em metade dos casos.
     */
    MEDIA_DIR: optionalString,

    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    RATE_LIMIT_PER_MINUTE: numberFrom(100),

    /**
     * Balde SEPARADO para os webhooks de canal (auditoria 2026-09-17).
     *
     * O gateway fala com o backend por IP fixo e sem Bearer, entao caia no
     * mesmo balde por IP de `RATE_LIMIT_PER_MINUTE` (100/min) — desenhado para
     * um usuario humano, nao para um gateway que reentrega ate 10 vezes e
     * dispara rajada a cada reconexao. Resultado medido: 3754 respostas 429 e
     * 462 entregas ABANDONADAS numa janela de 12 minutos.
     *
     * Continua existindo limite: webhook e rota publica e sem teto seria um
     * amplificador. Mas o teto passa a ser o de uma maquina, nao o de uma
     * pessoa.
     */
    RATE_LIMIT_WEBHOOK_PER_MINUTE: numberFrom(600),

    /**
     * Quantos proxies reversos NOSSOS ficam na frente do app (D-057).
     * `0` (default) = nao confia em `X-Forwarded-For` nenhum.
     */
    TRUST_PROXY_HOPS: nonNegativeNumberFrom(0),
    /** Lista de IPs/CIDRs de proxy confiavel. Tem precedencia sobre a contagem. */
    TRUSTED_PROXIES: optionalString,

    /**
     * Envio de e-mail (CRMLAB-39) — provedor Resend. Ausente em dev/teste =
     * `forgotPassword` loga o link em vez de enviar (mesmo padrao do driver
     * mock do WHATSAPP_API_URL). Obrigatoria em producao: sem ela a
     * recuperacao de senha fica sem efeito nenhum, silenciosamente.
     */
    RESEND_API_KEY: optionalString,
    /** Remetente verificado no Resend (dominio/subdominio autenticado por DNS). */
    RESEND_FROM_EMAIL: optionalString,

    /**
     * Sincronizacao dos orcamentos pela API do Bitlab (CRMLAB-52, D-185). A
     * CHAVE nao mora aqui: e por laboratorio, cifrada em `lis_sync_settings`.
     * A URL base e da instalacao — o Bitlab e um so.
     */
    BITLAB_API_BASE_URL: z.string().url().default('https://integracoes.bitlab.net.br/webhook'),
    /** Intervalo do agendador. `0` desliga o agendador (hml, testes); "Sincronizar agora" continua. */
    LIS_SYNC_INTERVAL_MS: z.preprocess((v) => {
      if (v === undefined || v === null || v === '') return 30 * 60 * 1000;
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }, z.number().int().min(0)),
    /** Primeira carga, sem marca d'agua: quantos dias para tras. */
    LIS_SYNC_INITIAL_DAYS: numberFrom(90),
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
    // D-076: sem chave, o segredo de HMAC de todo laboratorio fica em claro no
    // dump. Aviso nao resolve — quem le aviso ja tem o dump.
    if (!value.CHANNEL_SECRET_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CHANNEL_SECRET_KEY'],
        message:
          'CHANNEL_SECRET_KEY e obrigatoria em NODE_ENV=production (cifra as credenciais de canal em repouso, D-076)',
      });
    } else if (value.CHANNEL_SECRET_KEY.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CHANNEL_SECRET_KEY'],
        message: 'CHANNEL_SECRET_KEY precisa de ao menos 32 caracteres em producao',
      });
    } else if (PLACEHOLDER_SECRETS.has(value.CHANNEL_SECRET_KEY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CHANNEL_SECRET_KEY'],
        message: 'CHANNEL_SECRET_KEY ainda usa o valor de exemplo — gere um segredo unico',
      });
    }
    if (!value.MEDIA_DIR) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MEDIA_DIR'],
        message: 'MEDIA_DIR e obrigatoria em NODE_ENV=production (Onda 8 §4.1)',
      });
    }
    if (!value.RESEND_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RESEND_API_KEY'],
        message: 'RESEND_API_KEY e obrigatoria em NODE_ENV=production (CRMLAB-39)',
      });
    }
    if (!value.RESEND_FROM_EMAIL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RESEND_FROM_EMAIL'],
        message: 'RESEND_FROM_EMAIL e obrigatoria em NODE_ENV=production (CRMLAB-39)',
      });
    }
  });

export type RawEnv = z.infer<typeof envSchema>;

export interface Env extends Omit<RawEnv, 'JWT_SECRET' | 'JWT_REFRESH_SECRET' | 'MEDIA_DIR'> {
  JWT_SECRET: string;
  JWT_REFRESH_SECRET: string;
  /** Sempre resolvida — default por ambiente quando `MEDIA_DIR` nao foi setada. */
  MEDIA_DIR: string;
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
    MEDIA_DIR:
      value.MEDIA_DIR ??
      (value.NODE_ENV === 'test'
        ? path.join(os.tmpdir(), 'crm-lab-media-test')
        : path.resolve(here, '../../media')),
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
    'CHANNEL_SECRET_KEY',
    'EVOLUTION_API_KEY',
    'EVOLUTION_WEBHOOK_TOKEN',
    'RESEND_API_KEY',
  ];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'function') continue;
    out[key] = redactedKeys.includes(key) && value ? '***' : value;
  }
  return out;
}

export const env: Env = loadEnv();
