/**
 * Rotas das Regras do funil — `/api/v1/settings/funnel-rules`
 * (API_CONTRACTS.md §6c, CRMLAB-56 — D-190).
 *
 *   GET   /settings/funnel-rules   attendant/manager/admin
 *   PATCH /settings/funnel-rules   manager/admin
 *
 * A validacao do corpo mora no service (mesmo padrao de
 * `commission-settings.routes.ts`): o corpo chega cru, para o service decidir
 * o que e "campo desconhecido" em qualquer nivel.
 */
import { Router, type Request, type Response } from 'express';
import type { UpdateFunnelRulesRequest } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { createAuditService } from '../services/audit.service.js';
import { createFunnelRulesService } from '../services/funnel-rules.service.js';

export function funnelRulesModule(deps: ApiModuleDeps): ApiModule {
  const service = createFunnelRulesService({
    db: deps.db,
    audit: createAuditService(deps.db),
  });

  const router = Router();
  router.use(requireAuth(), denyPlatformOperator());

  router.get(
    '/',
    requireRoles('attendant', 'manager', 'admin'),
    (req: Request, res: Response, next): void => {
      service
        .get(getContext(req))
        .then((response) => res.status(200).json(response))
        .catch(next);
    },
  );

  router.patch('/', requireRoles('manager', 'admin'), (req: Request, res: Response, next): void => {
    const dto = (req.body ?? {}) as UpdateFunnelRulesRequest;
    service
      .update(getContext(req), dto)
      .then((response) => res.status(200).json(response))
      .catch(next);
  });

  return { basePath: '/settings/funnel-rules', router, requiresAuth: true };
}
