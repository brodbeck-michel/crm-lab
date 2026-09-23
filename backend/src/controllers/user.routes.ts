/**
 * Rotas de usuarios — `/api/v1/users/*`.
 *
 * `GET /users/me` e para qualquer usuario autenticado do laboratorio.
 * O resto e a tela `/settings/users`, restrita a **admin** (PAGES.md §10).
 *
 * `denyPlatformOperator()` fecha o console de plataforma para fora das rotas de
 * laboratorio (SECURITY.md "Console de Plataforma") — mesmo que um operador
 * tivesse papel `admin`, nao teria caminho aqui.
 *
 * INCLUSIVE `GET /users/me`, e isso e DELIBERADO (revisado em auditoria):
 * PAGES.md §11 manda o `platform_operator` ficar restrito a `/platform/*`
 * ("requisito, nao configuracao"), e AGENTS.md manda resolver ambiguidade pela
 * interpretacao mais restritiva. O console tambem nao precisa desta rota: o
 * proprio perfil ja vem no corpo de `POST /auth/login` / `POST /auth/refresh`
 * (`LoginResponse.user`), que e a fonte do `useAuthStore`. Abrir `/me` aqui
 * daria ao operador uma rota de tenant e um `tenant.theme` de laboratorio —
 * exatamente o acoplamento que §11 proibe. Ha teste do 403 em
 * `tests/kernel/route-tenant-isolation.spec.ts`.
 */
import cookieParser from 'cookie-parser';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ChangePasswordRequest, CreateUserRequest, UpdateUserRequest } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { REFRESH_COOKIE_NAME } from '../http/refresh-cookie.js';
import { createEmailService } from '../lib/email.js';
import { createAuditService } from '../services/audit.service.js';
import { createAuthService } from '../services/auth.service.js';
import { createThemeService } from '../services/theme.service.js';
import { createUserService, MIN_PASSWORD_LENGTH } from '../services/user.service.js';
import { MIN_NEW_PASSWORD_LENGTH } from '../lib/password-policy.js';

const assignableRole = z.enum(['attendant', 'manager', 'admin']);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().trim().optional(),
  isActive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
    .optional(),
});

const createUserSchema = z
  .object({
    email: z.string().trim().email('E-mail inválido'),
    name: z.string().trim().min(2, 'Nome muito curto').max(255),
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `Senha deve ter ao menos ${MIN_PASSWORD_LENGTH} caracteres`),
    role: assignableRole,
    discountLimit: z.number().int().min(0).max(100).optional(),
  })
  .strict();

const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(255).optional(),
    role: assignableRole.optional(),
    discountLimit: z.number().int().min(0).max(100).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((dto) => Object.keys(dto).length > 0, { message: 'Informe ao menos um campo' });

const idParamSchema = z.object({ id: z.string().uuid('Identificador inválido') });

/** `newPassword` mínimo aqui é só UX — a política de verdade é `checkPasswordPolicy` no service. */
const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Senha atual obrigatória'),
    newPassword: z
      .string()
      .min(MIN_NEW_PASSWORD_LENGTH, `Nova senha deve ter ao menos ${MIN_NEW_PASSWORD_LENGTH} caracteres`),
  })
  .strict();

export function userModule(deps: ApiModuleDeps): ApiModule {
  const audit = createAuditService(deps.db);
  const users = createUserService({ db: deps.db, audit });
  // Reaproveita o AuthService (login/refresh) para a lógica de sessão da
  // troca de senha (revogar famílias, ver CRMLAB-35/D-152) — não duplica
  // `issueRefreshToken`/hash de refresh aqui.
  const theme = createThemeService({ db: deps.db, audit });
  const email = createEmailService();
  const auth = createAuthService({ db: deps.db, cache: deps.cache, audit, theme, email });

  const router = Router();
  router.use(requireAuth(), denyPlatformOperator());
  // Só para LER o cookie de sessão em /me/password (D-152) — nunca seta
  // cookie de auth por aqui.
  router.use(cookieParser());

  router.get('/me', (req: Request, res: Response, next): void => {
    users
      .getMe(getContext(req))
      .then((result) => res.status(200).json(result))
      .catch(next);
  });

  router.patch(
    '/me/password',
    validate(changePasswordSchema, 'body'),
    (req: Request, res: Response, next): void => {
      const ctx = getContext(req);
      const dto = validated<ChangePasswordRequest>(req, 'body');
      const currentRefreshToken =
        (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE_NAME] ?? null;
      auth
        .changePassword(
          { tenantId: ctx.tenantId, userId: ctx.userId, role: ctx.role },
          { ...dto, currentRefreshToken },
          { ip: ctx.ip, userAgent: ctx.userAgent },
        )
        .then(() => res.status(200).json({ message: 'Senha alterada com sucesso' }))
        .catch(next);
    },
  );

  router.get(
    '/',
    requireRoles('admin'),
    validate(listQuerySchema, 'query'),
    (req: Request, res: Response, next): void => {
      const query = validated<z.infer<typeof listQuerySchema>>(req, 'query');
      users
        .list(getContext(req), query)
        .then((result) => res.status(200).json(result))
        .catch(next);
    },
  );

  router.post(
    '/',
    requireRoles('admin'),
    validate(createUserSchema, 'body'),
    (req: Request, res: Response, next): void => {
      const dto = validated<CreateUserRequest>(req, 'body');
      users
        .create(getContext(req), dto)
        .then((result) => res.status(201).json(result))
        .catch(next);
    },
  );

  router.patch(
    '/:id',
    requireRoles('admin'),
    validate(idParamSchema, 'params'),
    validate(updateUserSchema, 'body'),
    (req: Request, res: Response, next): void => {
      const { id } = validated<z.infer<typeof idParamSchema>>(req, 'params');
      const dto = validated<UpdateUserRequest>(req, 'body');
      users
        .update(getContext(req), id, dto)
        .then((result) => res.status(200).json(result))
        .catch(next);
    },
  );

  return { basePath: '/users', router, requiresAuth: true };
}
