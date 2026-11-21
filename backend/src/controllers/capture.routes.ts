/**
 * Rotas do celular pareado — API_CONTRACTS.md §15.2 (CRMLAB-184, D-327).
 *
 *   POST /api/v1/capture/pair      codigo -> cookie `crm_capture` (200)
 *   GET  /api/v1/capture/session   "estou pareado?" (200 | 401)
 *   POST /api/v1/capture/scans     uma foto para a fila (201)
 *
 * PUBLICAS para o kernel (sem Bearer, sem `requireAuth`): a credencial e o
 * cookie httpOnly do dispositivo, e ela so envia foto para a fila
 * (SECURITY.md "Dispositivo de captura").
 *
 * Defesas, nesta ordem:
 * - `POST`: `Origin` contra `env.corsOrigins` ANTES de olhar o cookie (CSRF,
 *   a mesma checagem do handshake do WebSocket);
 * - `/pair`: 10 tentativas / 15 min por IP, contadas ANTES de conferir o
 *   codigo; Redis fora = 503 (fail-closed, como `/auth/login`);
 * - `/session` e `/scans`: o limitador global e por DISPOSITIVO, montado aqui
 *   depois de autenticar (o global do `app.ts` pula estas duas). Sem cookie
 *   valido a contagem cai no balde do IP — e a resposta e 401.
 */
import {
  Router,
  type CookieOptions,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { z } from 'zod';
import type { CaptureSession, CreateScanResponse } from '@crm-lab/shared';
import { env } from '../config/env.js';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { clientIp, userAgentOf } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import { rateLimit } from '../http/middleware/rate-limit.js';
import { validate, validated } from '../http/middleware/validate.js';
import { logCacheUnavailable, type CacheService } from '../lib/cache.js';
import {
  CAPTURE_COOKIE_MAX_AGE_MS,
  CAPTURE_COOKIE_NAME,
  CAPTURE_COOKIE_PATH,
  getCookie,
} from '../lib/cookies.js';
import { createAuditService } from '../services/audit.service.js';
import {
  CaptureDeviceService,
  type CaptureDeviceContext,
} from '../services/capture-device.service.js';
import { ScanService } from '../services/scan.service.js';

/** 10 tentativas / 15 min por IP (API_CONTRACTS §15.2). */
export const PAIR_ATTEMPT_LIMIT = 10;
export const PAIR_WINDOW_SECONDS = 15 * 60;

export const capturePairSchema = z.object({ code: z.string().trim().min(1).max(32) });

export const createScanSchema = z.object({
  mimeType: z.string().trim().min(1).max(127),
  contentBase64: z.string().min(1),
});

function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** `Secure` so em producao/homologacao (mesma regra do `crm_refresh`). */
export function captureCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'strict',
    path: CAPTURE_COOKIE_PATH,
    maxAge: CAPTURE_COOKIE_MAX_AGE_MS,
  };
}

/** CSRF: `Origin` ausente ou fora da lista = 403, antes de olhar o cookie. */
export function requireAllowedOrigin(): RequestHandler {
  return (req, _res, next) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !env.corsOrigins.includes(origin)) {
      next(new BusinessError('FORBIDDEN', { reason: 'origin_not_allowed' }));
      return;
    }
    next();
  };
}

function pairThrottle(cache: CacheService): RequestHandler {
  return (req, res, next) => {
    cache
      .incr(`capture-pair:${clientIp(req)}`, PAIR_WINDOW_SECONDS)
      .then((hits) => {
        if (hits > PAIR_ATTEMPT_LIMIT) {
          res.setHeader('Retry-After', String(PAIR_WINDOW_SECONDS));
          next(new BusinessError('RATE_LIMIT_EXCEEDED', { retryAfter: PAIR_WINDOW_SECONDS }));
          return;
        }
        next();
      })
      .catch((err: unknown) => {
        // Rota publica: Redis fora = fail-CLOSED (D-139), como `/auth/login`.
        logCacheUnavailable({
          scope: 'capture.pair_throttle',
          message: err instanceof Error ? err.message : String(err),
        });
        next(new BusinessError('SERVICE_UNAVAILABLE'));
      });
  };
}

/** Dispositivo autenticado desta requisicao (preenchido por `identifyDevice`). */
const devices = new WeakMap<Request, CaptureDeviceContext>();

function deviceOf(req: Request): CaptureDeviceContext {
  const device = devices.get(req);
  if (!device) throw new BusinessError('CAPTURE_DEVICE_UNPAIRED');
  return device;
}

/**
 * Le o cookie e acha o dispositivo. NAO recusa aqui: a recusa (401) vem
 * depois do limitador, para que tentativa sem credencial tambem conte.
 */
function identifyDevice(service: CaptureDeviceService): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    service
      .authenticate(getCookie(req.headers.cookie, CAPTURE_COOKIE_NAME))
      .then((device) => {
        devices.set(req, device);
        next();
      })
      .catch((err: unknown) => {
        if (err instanceof BusinessError && err.code === 'CAPTURE_DEVICE_UNPAIRED') {
          next();
          return;
        }
        next(err);
      });
  };
}

function requireDevice(): RequestHandler {
  return (req, _res, next) => {
    if (!devices.has(req)) {
      next(new BusinessError('CAPTURE_DEVICE_UNPAIRED'));
      return;
    }
    next();
  };
}

export function captureModule(deps: ApiModuleDeps): ApiModule {
  const audit = createAuditService(deps.db);
  const captureDevices = new CaptureDeviceService({ db: deps.db, audit });
  const scans = new ScanService({ db: deps.db, audit });
  const router = Router();

  // Chave = dispositivo; sem dispositivo, o mesmo balde de IP do global.
  const deviceLimiter = rateLimit({
    cache: deps.cache,
    keyResolver: (req) => {
      const device = devices.get(req);
      return device ? `capture-device:${device.deviceId}` : `ip:${clientIp(req)}`;
    },
  });
  const authenticated = [identifyDevice(captureDevices), deviceLimiter, requireDevice()];

  router.post(
    '/pair',
    requireAllowedOrigin(),
    pairThrottle(deps.cache),
    validate(capturePairSchema, 'body'),
    handle(async (req, res) => {
      const { code } = validated<{ code: string }>(req, 'body');
      const { token, ...session } = await captureDevices.pair(code, {
        ip: clientIp(req),
        userAgent: userAgentOf(req),
      });
      res.cookie(CAPTURE_COOKIE_NAME, token, captureCookieOptions());
      const body: CaptureSession = session;
      res.status(200).json(body);
    }),
  );

  router.get(
    '/session',
    ...authenticated,
    handle(async (req, res) => {
      const device = deviceOf(req);
      const body: CaptureSession = { deviceName: device.deviceName, tenantName: device.tenantName };
      res.status(200).json(body);
    }),
  );

  router.post(
    '/scans',
    requireAllowedOrigin(),
    ...authenticated,
    validate(createScanSchema, 'body'),
    handle(async (req, res) => {
      const device = deviceOf(req);
      const dto = validated<{ mimeType: string; contentBase64: string }>(req, 'body');
      const body: CreateScanResponse = await scans.create(device, dto);
      // Renova o cookie a cada envio (400 dias contados do ultimo uso).
      const token = getCookie(req.headers.cookie, CAPTURE_COOKIE_NAME);
      if (token !== undefined) res.cookie(CAPTURE_COOKIE_NAME, token, captureCookieOptions());
      res.status(201).json(body);
    }),
  );

  return { basePath: '/capture', router, requiresAuth: false };
}
