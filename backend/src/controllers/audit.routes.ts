/**
 * Rotas de auditoria — `/api/v1/audit` (aba "Log de auditoria" de
 * `/settings/users`, PAGES.md §10). SOMENTE admin.
 *
 * Append-only: existe GET e mais nada. Nao ha — e nao deve haver — rota de
 * escrita, edicao ou remocao de audit log (SECURITY.md "Auditoria": logs NUNCA
 * sao editaveis via API). Os registros nascem dos services.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ListAuditQuery } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';

const listAuditSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  action: z.string().trim().max(100).optional(),
  entityType: z.string().trim().max(50).optional(),
  entityId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export function auditModule(deps: ApiModuleDeps): ApiModule {
  const audit = createAuditService(deps.db);

  const router = Router();
  router.use(requireAuth(), denyPlatformOperator(), requireRoles('admin'));

  router.get('/', validate(listAuditSchema, 'query'), (req: Request, res: Response, next): void => {
    const query = validated<ListAuditQuery>(req, 'query');
    audit
      .query(getContext(req), query)
      .then((result) => res.status(200).json(result))
      .catch(next);
  });

  return { basePath: '/audit', router, requiresAuth: true };
}
