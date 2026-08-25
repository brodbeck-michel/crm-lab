/**
 * Rota de Gestao da Operacao — `GET /api/v1/operations/overview` (PAGES.md §10,
 * API_CONTRACTS.md §7).
 *
 * UMA rota, nao tres (D-067): os tres blocos da tela sao o retrato do mesmo
 * instante e saem das mesmas duas tabelas.
 *
 * `denyPlatformOperator()` vem ANTES do `requireRoles('manager','admin')` de
 * proposito: assim o operador da plataforma recebe `requiredRoles` de
 * LABORATORIO, o que prova no teste que quem recusou foi o guard de plataforma
 * e nao a tabela de papeis — se um dia alguem afrouxar os papeis, o guard
 * continua de pe.
 *
 * O zod aqui so coage `queueLimit`/`decisionsLimit` de string de query para
 * numero. A FAIXA (1..100) e validada no SERVICE, que e onde a regra vale
 * tambem para quem chama sem middleware — o mesmo arranjo do AnalyticsService.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { OperationOverviewQuery } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createOperationService } from '../services/operation.service.js';

const overviewQuerySchema = z.object({
  queueLimit: z.coerce.number().optional(),
  decisionsLimit: z.coerce.number().optional(),
});

export function operationModule(deps: ApiModuleDeps): ApiModule {
  const operation = createOperationService({ db: deps.db });

  const router = Router();
  router.use(requireAuth(), denyPlatformOperator());

  router.get(
    '/overview',
    requireRoles('manager', 'admin'),
    validate(overviewQuerySchema, 'query'),
    (req: Request, res: Response, next): void => {
      const query = validated<OperationOverviewQuery>(req, 'query');
      operation
        .getOverview(getContext(req), query)
        .then((overview) => res.status(200).json(overview))
        .catch(next);
    },
  );

  return { basePath: '/operations', router, requiresAuth: true };
}
