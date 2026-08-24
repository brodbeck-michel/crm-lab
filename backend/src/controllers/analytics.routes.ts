/**
 * Rotas de analytics — `/api/v1/analytics/*` (tela Conversao, PAGES.md §8).
 *
 * `GET /analytics/conversion` e `GET /analytics/pipeline` sao abertas a
 * qualquer usuario do laboratorio; o ESCOPO e que muda: atendente recebe so as
 * proprias metricas, com `partial: true`. Isso e decidido no service, a partir
 * do papel do token — nunca de um parametro do cliente.
 *
 * `GET /analytics/team` exige `requireRoles('manager','admin')`.
 *
 * `denyPlatformOperator()` fecha as tres para o console da plataforma: o
 * operador nao tem caminho para dado de laboratorio (SECURITY.md "Console de
 * Plataforma"). Nao ha rota de escrita neste modulo — o service e read-only.
 *
 * A validacao das datas fica no SERVICE (`resolvePeriod`), nao no zod: a regra
 * de periodo invertido e o default sao logica de negocio e precisam valer
 * tambem para quem chama o service sem middleware. O zod aqui so recusa o que
 * nem chega a ser uma query (tipo errado, string gigante).
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAnalyticsService, type DateRange } from '../services/analytics.service.js';

const periodSchema = z.object({
  startDate: z.string().trim().max(32).optional(),
  endDate: z.string().trim().max(32).optional(),
  // Aceito pelo contrato (API_CONTRACTS.md §5); a serie temporal ainda nao e
  // exposta, entao o valor e validado e ignorado — melhor que 400 numa query
  // que o frontend tem direito de mandar.
  groupBy: z.enum(['daily', 'weekly', 'monthly']).optional(),
});

export function analyticsModule(deps: ApiModuleDeps): ApiModule {
  const analytics = createAnalyticsService({ db: deps.db, cache: deps.cache });

  const router = Router();
  router.use(requireAuth(), denyPlatformOperator());

  router.get(
    '/conversion',
    validate(periodSchema, 'query'),
    (req: Request, res: Response, next): void => {
      const query = validated<DateRange>(req, 'query');
      analytics
        .getConversionFunnel(getContext(req), query)
        .then((report) => res.status(200).json(report))
        .catch(next);
    },
  );

  router.get('/pipeline', (req: Request, res: Response, next): void => {
    analytics
      .getPipelineSnapshot(getContext(req))
      .then((snapshot) => res.status(200).json(snapshot))
      .catch(next);
  });

  router.get(
    '/team',
    requireRoles('manager', 'admin'),
    validate(periodSchema, 'query'),
    (req: Request, res: Response, next): void => {
      const query = validated<DateRange>(req, 'query');
      analytics
        .getTeamPerformance(getContext(req), query)
        .then((report) => res.status(200).json(report))
        .catch(next);
    },
  );

  return { basePath: '/analytics', router, requiresAuth: true };
}
