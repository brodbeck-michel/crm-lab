/**
 * Rotas do console da plataforma — `/api/v1/platform/*` (PAGES.md §11).
 *
 * TODAS exigem `platform_operator`, aplicado no `router.use` para que uma rota
 * nova nao possa nascer aberta por esquecimento. O service repete a checagem
 * ("a UI esconde, o servidor recusa"), porque este e o unico caminho do sistema
 * que roda sem RLS.
 *
 * O inverso tambem e verdade e igualmente importante: as rotas de laboratorio
 * fecham a porta para o operador com `denyPlatformOperator()` (ja aplicado em
 * `/themes`, `/users`, `/audit`, `/exams` e `/analytics`). Modulo novo de dado
 * de laboratorio — conversas, mensagens, propostas, chat interno — DEVE usar o
 * mesmo guard: o isolamento do console e requisito, nao configuracao.
 *
 * Nao existe rota que devolva conversa, mensagem, paciente ou canal interno de
 * laboratorio, e nao deve passar a existir.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { CreateTenantRequest } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import {
  createPlatformService,
  MAX_LIMIT,
  MIN_PASSWORD_LENGTH,
  type ListTenantsQuery,
} from '../services/platform.service.js';

const listTenantsSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  search: z.string().trim().max(255).optional(),
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  plan: z.enum(['starter', 'pro', 'enterprise']).optional(),
});

/**
 * O zod recusa o que nem e um DTO; as regras de negocio (slug canonico,
 * tamanho minimo de senha, plano valido) vivem tambem no service, que e
 * chamado sem middleware nos testes unitarios.
 */
const createTenantSchema = z
  .object({
    name: z.string().trim().min(2).max(255),
    slug: z.string().trim().min(2).max(100),
    plan: z.enum(['starter', 'pro', 'enterprise']),
    adminEmail: z.string().trim().email().max(255),
    adminName: z.string().trim().min(2).max(255),
    adminPassword: z.string().min(MIN_PASSWORD_LENGTH).max(200),
  })
  .strict();

export function platformModule(deps: ApiModuleDeps): ApiModule {
  const audit = createAuditService(deps.db);
  const platform = createPlatformService({ db: deps.db, audit });

  const router = Router();
  router.use(requireAuth(), requireRoles('platform_operator'));

  router.get(
    '/tenants',
    validate(listTenantsSchema, 'query'),
    (req: Request, res: Response, next): void => {
      const query = validated<ListTenantsQuery>(req, 'query');
      platform
        .listTenants(getContext(req), query)
        .then((result) => res.status(200).json(result))
        .catch(next);
    },
  );

  router.post(
    '/tenants',
    validate(createTenantSchema, 'body'),
    (req: Request, res: Response, next): void => {
      const dto = validated<CreateTenantRequest>(req, 'body');
      platform
        .createTenant(getContext(req), dto)
        .then((tenant) => res.status(201).json({ tenant }))
        .catch(next);
    },
  );

  router.get('/billing', (req: Request, res: Response, next): void => {
    platform
      .getBilling(getContext(req))
      .then((billing) => res.status(200).json(billing))
      .catch(next);
  });

  return { basePath: '/platform', router, requiresAuth: true };
}
