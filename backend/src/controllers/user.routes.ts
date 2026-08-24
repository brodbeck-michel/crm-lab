/**
 * Rotas de usuarios — `/api/v1/users/*`.
 *
 * `GET /users/me` e para qualquer usuario autenticado do laboratorio.
 * O resto e a tela `/settings/users`, restrita a **admin** (PAGES.md §10).
 *
 * `denyPlatformOperator()` fecha o console de plataforma para fora das rotas de
 * laboratorio (SECURITY.md "Console de Plataforma") — mesmo que um operador
 * tivesse papel `admin`, nao teria caminho aqui.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { CreateUserRequest, UpdateUserRequest } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import { createUserService, MIN_PASSWORD_LENGTH } from '../services/user.service.js';

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

export function userModule(deps: ApiModuleDeps): ApiModule {
  const audit = createAuditService(deps.db);
  const users = createUserService({ db: deps.db, audit });

  const router = Router();
  router.use(requireAuth(), denyPlatformOperator());

  router.get('/me', (req: Request, res: Response, next): void => {
    users
      .getMe(getContext(req))
      .then((result) => res.status(200).json(result))
      .catch(next);
  });

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
