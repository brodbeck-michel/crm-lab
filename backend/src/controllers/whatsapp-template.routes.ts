/**
 * `GET /api/v1/whatsapp/templates` (CRMLAB-136, D-309, API_CONTRACTS §6.2).
 *
 * Modelos aprovados da Meta do PROPRIO laboratorio (tenant do token), para o
 * Composer e a Nova conversa. Atendente, gestor e admin. Laboratorio em `qr`
 * recebe lista vazia; credencial incompleta, 409; Meta fora do ar, 503.
 */
import { Router, type Request, type Response } from 'express';
import type { ListWhatsAppTemplatesResponse } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { createWhatsAppService, type WhatsAppService } from '../services/whatsapp.service.js';

export function makeWhatsAppTemplateModule(
  overrides: { whatsapp?: WhatsAppService } = {},
): (deps: ApiModuleDeps) => ApiModule {
  return (deps) => buildModule(deps, overrides);
}

export function whatsappTemplateModule(deps: ApiModuleDeps): ApiModule {
  return buildModule(deps, {});
}

function buildModule(deps: ApiModuleDeps, overrides: { whatsapp?: WhatsAppService }): ApiModule {
  const whatsapp = overrides.whatsapp ?? createWhatsAppService(deps.db);
  const router = Router();
  router.use(requireAuth(), denyPlatformOperator());

  router.get(
    '/templates',
    requireRoles('attendant', 'manager', 'admin'),
    (req: Request, res: Response, next): void => {
      const { tenantId } = getContext(req);
      whatsapp
        .listTemplates(tenantId)
        .then((templates) => {
          const body: ListWhatsAppTemplatesResponse = { templates };
          res.status(200).json(body);
        })
        .catch(next);
    },
  );

  return { basePath: '/whatsapp', router, requiresAuth: true };
}
