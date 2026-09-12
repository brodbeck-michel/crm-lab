/**
 * Rotas de comissão — `/api/v1/settings/commissions` (API_CONTRACTS.md §6b,
 * Onda 9 — D-113).
 *
 *   GET   /settings/commissions   manager/admin
 *   PATCH /settings/commissions   admin
 *
 * A validação do corpo mora no service (mesmo padrão de
 * `channel-settings.routes.ts`): o corpo chega cru, para o service decidir o
 * que é "campo desconhecido" no schema `strict`.
 */
import { Router, type Request, type Response } from 'express';
import type { UpdateCommissionSettingsRequest } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { createAuditService } from '../services/audit.service.js';
import { createCommissionSettingsService } from '../services/commission-settings.service.js';

export function commissionSettingsModule(deps: ApiModuleDeps): ApiModule {
  const service = createCommissionSettingsService({
    db: deps.db,
    audit: createAuditService(deps.db),
  });

  const router = Router();
  router.use(requireAuth(), denyPlatformOperator());

  router.get(
    '/',
    requireRoles('manager', 'admin'),
    (req: Request, res: Response, next): void => {
      service
        .get(getContext(req))
        .then((response) => res.status(200).json(response))
        .catch(next);
    },
  );

  router.patch(
    '/',
    requireRoles('admin'),
    (req: Request, res: Response, next): void => {
      const dto = (req.body ?? {}) as UpdateCommissionSettingsRequest;
      service
        .update(getContext(req), dto)
        .then((response) => res.status(200).json(response))
        .catch(next);
    },
  );

  // basePath dedicado (nao "/settings", que ja pertence ao channel-settings
  // module — app.ts recusa basePath duplicado entre modulos).
  return { basePath: '/settings/commissions', router, requiresAuth: true };
}
