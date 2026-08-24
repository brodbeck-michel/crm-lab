/**
 * ThemeService — personalizacao visual do tenant (SERVICES.md §8, WORKFLOWS §9).
 *
 * D-005: persistimos SO as 5 cores base + radiusId + fontId + brand. As 27
 * variacoes sao derivadas no frontend com `color-mix(in oklab)` — a API nunca
 * devolve rampa.
 *
 * O tema tambem viaja no payload de `POST /auth/login`
 * (FRONTEND_BACKEND.md: "o tema vem no login — o frontend nao faz request
 * extra"), por isso `getCurrent` e chamado tanto pela rota quanto pelo
 * AuthService.
 */
import type { Theme, ThemePreset, UpdateThemeRequest } from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError } from '../http/errors.js';
import * as themeRepo from '../repositories/theme.repository.js';
import type { AuditService } from './audit.service.js';

/** Regex canonico de cor: `#rrggbb`, 6 digitos, sem forma curta. */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value);
}

/** Os 5 temas prontos de docs/design/DESIGN_TOKENS.md (estatico). */
export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: 'terracota',
    name: 'Terracota & Sálvia',
    accent: '#c67139',
    accent2: '#7a8a5e',
    bg: '#f5ead8',
    surface: '#ebddc5',
    text: '#1a1a1a',
  },
  {
    id: 'jaleco',
    name: 'Azul Jaleco',
    accent: '#2f6f9f',
    accent2: '#4f9d8b',
    bg: '#eef3f7',
    surface: '#dbe6ef',
    text: '#1a1a1a',
  },
  {
    id: 'esteril',
    name: 'Verde Esterilizado',
    accent: '#2f7d5f',
    accent2: '#6d8f4e',
    bg: '#eef5f0',
    surface: '#d9e8de',
    text: '#1a1a1a',
  },
  {
    id: 'hemograma',
    name: 'Hemograma',
    accent: '#a63a3a',
    accent2: '#7a6b8a',
    bg: '#f7efee',
    surface: '#ecdad8',
    text: '#1a1a1a',
  },
  {
    id: 'diagnostico',
    name: 'Lilás Diagnóstico',
    accent: '#6a4f9c',
    accent2: '#3f8a9a',
    bg: '#f3f1f8',
    surface: '#e2dcef',
    text: '#1a1a1a',
  },
] as const;

/** Tenant sem linha em `themes` usa o tema 1 (padrao do design system). */
export const DEFAULT_THEME: Theme = {
  accent: THEME_PRESETS[0]!.accent,
  accent2: THEME_PRESETS[0]!.accent2,
  bg: THEME_PRESETS[0]!.bg,
  surface: THEME_PRESETS[0]!.surface,
  text: THEME_PRESETS[0]!.text,
  fontId: 'figtree',
  radiusId: 'suave',
  brandName: null,
  logoUrl: null,
};

export interface ThemeService {
  /** Tema do tenant; o padrao quando ainda nao houve personalizacao. */
  getCurrent(tenantId: string): Promise<Theme>;
  /** Le o tema dentro de uma transacao ja aberta (usado pelo login). */
  getCurrentIn(tx: DbTx, tenantId: string): Promise<Theme>;
  /** Salva a personalizacao. SOMENTE admin. */
  update(ctx: TenantContext, dto: UpdateThemeRequest): Promise<Theme>;
  getPresets(): ThemePreset[];
}

export interface ThemeServiceDeps {
  db: DbClient;
  audit: AuditService;
}

const COLOR_FIELDS = ['accent', 'accent2', 'bg', 'surface', 'text'] as const;
type ColorField = (typeof COLOR_FIELDS)[number];

/**
 * Validacao de hex no service (alem do zod da rota): o contrato de SERVICES.md
 * §8 e "validar formato hex das cores", e o service e chamado tambem pelo teste
 * unitario e por qualquer futuro consumidor sem middleware.
 */
function assertHexColors(dto: UpdateThemeRequest): void {
  const fields: Record<string, string> = {};
  for (const field of COLOR_FIELDS) {
    const value = dto[field as ColorField];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !isHexColor(value)) {
      fields[field] = 'Cor deve estar no formato hexadecimal #rrggbb';
    }
  }
  if (Object.keys(fields).length > 0) {
    throw new BusinessError('VALIDATION_ERROR', { fields });
  }
}

export function createThemeService(deps: ThemeServiceDeps): ThemeService {
  const { db, audit } = deps;

  const getCurrentIn = async (tx: DbTx, tenantId: string): Promise<Theme> =>
    (await themeRepo.findCurrent(tx, tenantId)) ?? DEFAULT_THEME;

  const getCurrent = async (tenantId: string): Promise<Theme> =>
    db.withTenant(tenantId, (tx) => getCurrentIn(tx, tenantId));

  const update = async (ctx: TenantContext, dto: UpdateThemeRequest): Promise<Theme> => {
    if (ctx.role !== 'admin') {
      throw new BusinessError('FORBIDDEN', { requiredRoles: ['admin'] });
    }
    assertHexColors(dto);

    const { previous, saved } = await db.withTenant(ctx.tenantId, async (tx) => {
      const current = await getCurrentIn(tx, ctx.tenantId);
      // Merge parcial: PATCH nao apaga o que nao foi enviado.
      const next: Theme = {
        accent: dto.accent ?? current.accent,
        accent2: dto.accent2 ?? current.accent2,
        bg: dto.bg ?? current.bg,
        surface: dto.surface ?? current.surface,
        text: dto.text ?? current.text,
        fontId: dto.fontId ?? current.fontId,
        radiusId: dto.radiusId ?? current.radiusId,
        brandName: dto.brandName !== undefined ? dto.brandName : current.brandName,
        logoUrl: dto.logoUrl !== undefined ? dto.logoUrl : current.logoUrl,
      };
      return { previous: current, saved: await themeRepo.upsert(tx, ctx.tenantId, next) };
    });

    await audit.record(ctx, {
      action: 'update_theme',
      entityType: 'theme',
      entityId: ctx.tenantId,
      oldValues: { ...previous },
      newValues: { ...saved },
    });

    return saved;
  };

  const getPresets = (): ThemePreset[] => THEME_PRESETS.map((preset) => ({ ...preset }));

  return { getCurrent, getCurrentIn, update, getPresets };
}
