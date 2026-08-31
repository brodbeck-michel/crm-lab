/**
 * Rotas de Canais & Equipe — `/api/v1/settings/channels` (PAGES.md §10,
 * API_CONTRACTS.md §6).
 *
 * `GET` e gestor+admin (a tela e leitura para o gestor); `PATCH` e admin.
 * `denyPlatformOperator()` fecha as duas para o console da plataforma, ANTES do
 * `requireRoles`: assim o operador recebe `requiredRoles` de LABORATORIO
 * (`attendant/manager/admin`), que e o que o contrato manda e o que prova, no
 * teste, que quem recusou foi o guard de plataforma e nao a tabela de papeis.
 *
 * A validacao do corpo mora no SERVICE, nao num zod aqui. Duas razoes:
 * (1) a semantica de segredo depende da distincao entre "chave ausente" e
 * "chave com `null`", e ela precisa valer tambem para quem chama o service sem
 * middleware; (2) o merge parcial de `autoMessages` depende do estado
 * guardado, que so o service conhece. O que sobra para a rota e o papel.
 */
import { Router, type Request, type Response } from 'express';
import type { UpdateChannelSettingsRequest, WhatsAppQrConnectRequest } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import type { EvolutionClient } from '../lib/evolution-client.js';
import { createAuditService } from '../services/audit.service.js';
import { createChannelSettingsService } from '../services/channel-settings.service.js';

/**
 * Mesmo padrao de `makeWebhookModule` em `webhook.routes.ts`: a fabrica plana
 * (`channelSettingsModule`) e o caso comum (gateway Evolution real/env var); o
 * teste que precisa de um gateway de mentira usa `makeChannelSettingsModule`.
 */
export function makeChannelSettingsModule(
  overrides: { evolutionClient?: EvolutionClient } = {},
): (deps: ApiModuleDeps) => ApiModule {
  return (deps) => buildChannelSettingsModule(deps, overrides);
}

export function channelSettingsModule(deps: ApiModuleDeps): ApiModule {
  return buildChannelSettingsModule(deps, {});
}

function buildChannelSettingsModule(
  deps: ApiModuleDeps,
  overrides: { evolutionClient?: EvolutionClient },
): ApiModule {
  const settings = createChannelSettingsService({
    db: deps.db,
    audit: createAuditService(deps.db),
    ...(overrides.evolutionClient !== undefined
      ? { evolutionClient: overrides.evolutionClient }
      : {}),
  });

  const router = Router();
  router.use(requireAuth(), denyPlatformOperator());

  router.get(
    '/channels',
    requireRoles('manager', 'admin'),
    (req: Request, res: Response, next): void => {
      settings
        .get(getContext(req))
        .then((response) => res.status(200).json(response))
        .catch(next);
    },
  );

  router.patch(
    '/channels',
    requireRoles('admin'),
    (req: Request, res: Response, next): void => {
      // O corpo chega cru de proposito: `undefined` (chave ausente) e `null`
      // (apagar) sao valores DIFERENTES para o service.
      const dto = (req.body ?? {}) as UpdateChannelSettingsRequest;
      settings
        .update(getContext(req), dto)
        .then((response) => res.status(200).json(response))
        .catch(next);
    },
  );

  // -------------------------------------------------------------------------
  // Conexao WhatsApp por QR (Onda 7, Bloco B) — todas admin apenas.
  // -------------------------------------------------------------------------

  router.post(
    '/channels/whatsapp/connect',
    requireRoles('admin'),
    (req: Request, res: Response, next): void => {
      const dto = (req.body ?? {}) as WhatsAppQrConnectRequest;
      settings
        .connectWhatsAppQr(getContext(req), dto)
        .then((response) => res.status(200).json(response))
        .catch(next);
    },
  );

  router.get(
    '/channels/whatsapp/qr',
    requireRoles('admin'),
    (req: Request, res: Response, next): void => {
      settings
        .getWhatsAppQr(getContext(req))
        .then((response) => res.status(200).json(response))
        .catch(next);
    },
  );

  router.get(
    '/channels/whatsapp/status',
    requireRoles('admin'),
    (req: Request, res: Response, next): void => {
      settings
        .getWhatsAppStatus(getContext(req))
        .then((response) => res.status(200).json(response))
        .catch(next);
    },
  );

  router.post(
    '/channels/whatsapp/disconnect',
    requireRoles('admin'),
    (req: Request, res: Response, next): void => {
      settings
        .disconnectWhatsApp(getContext(req))
        .then(() => res.status(204).send())
        .catch(next);
    },
  );

  return { basePath: '/settings', router, requiresAuth: true };
}
