/**
 * Rotas de tema — `/api/v1/themes/*` (tela `/settings/theme`, WORKFLOWS §9).
 *
 * `GET /themes/current` e `GET /themes/presets` sao leitura para qualquer
 * usuario autenticado do laboratorio (o preview da tela precisa dos presets);
 * `PATCH /themes/current` e **admin**.
 *
 * A validacao de hex vive no zod aqui (vira `VALIDATION_ERROR` com
 * `details.fields`) E no service — o service e chamado tambem sem middleware.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { UpdateThemeRequest } from '@crm-lab/shared';
import type { ApiModule, ApiModuleDeps } from '../http/api-module.js';
import { getContext } from '../http/context.js';
import { denyPlatformOperator, requireAuth, requireRoles } from '../http/middleware/auth.js';
import { validate, validated } from '../http/middleware/validate.js';
import { createAuditService } from '../services/audit.service.js';
import { createThemeService, HEX_COLOR_PATTERN } from '../services/theme.service.js';

const hexColor = z
  .string()
  .regex(HEX_COLOR_PATTERN, 'Cor deve estar no formato hexadecimal #rrggbb');

const updateThemeSchema = z
  .object({
    accent: hexColor.optional(),
    accent2: hexColor.optional(),
    bg: hexColor.optional(),
    surface: hexColor.optional(),
    text: hexColor.optional(),
    fontId: z.enum(['figtree', 'playfair', 'system']).optional(),
    radiusId: z.enum(['reto', 'suave', 'redondo']).optional(),
    brandName: z.string().trim().max(255).nullable().optional(),
    logoUrl: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .refine((dto) => Object.keys(dto).length > 0, { message: 'Informe ao menos um campo' });

export function themeModule(deps: ApiModuleDeps): ApiModule {
  const audit = createAuditService(deps.db);
  const themes = createThemeService({ db: deps.db, audit });

  const router = Router();
  router.use(requireAuth(), denyPlatformOperator());

  router.get('/current', (req: Request, res: Response, next): void => {
    themes
      .getCurrent(getContext(req).tenantId)
      .then((theme) => res.status(200).json({ theme }))
      .catch(next);
  });

  // Estatico (D-005 / DESIGN_TOKENS.md): nao toca o banco.
  router.get('/presets', (_req: Request, res: Response): void => {
    res.status(200).json({ presets: themes.getPresets() });
  });

  router.patch(
    '/current',
    requireRoles('admin'),
    validate(updateThemeSchema, 'body'),
    (req: Request, res: Response, next): void => {
      const dto = validated<UpdateThemeRequest>(req, 'body');
      themes
        .update(getContext(req), dto)
        .then((theme) => res.status(200).json({ theme }))
        .catch(next);
    },
  );

  return { basePath: '/themes', router, requiresAuth: true };
}
