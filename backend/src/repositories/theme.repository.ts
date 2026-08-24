/**
 * Acesso a tabela `themes` (1:1 com tenant, via `tenant_id UNIQUE`).
 *
 * D-005: persistimos SO as 5 cores base + radiusId + fontId + brand. As 27
 * variacoes sao derivadas no frontend por `color-mix(in oklab)` — nenhuma rampa
 * trafega na API.
 */
import type { FontId, RadiusId, Theme } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';

interface ThemeRow {
  accent: string;
  accent_2: string;
  bg: string;
  surface: string;
  text: string;
  font_id: string | null;
  radius_id: string | null;
  brand_name: string | null;
  logo_url: string | null;
}

const RADIUS_IDS: readonly RadiusId[] = ['reto', 'suave', 'redondo'];
const FONT_IDS: readonly FontId[] = ['figtree', 'playfair', 'system'];

/**
 * A migracao 001 traz `radius_id DEFAULT 'md'`, herdado da nomenclatura de
 * `--radius-md`. O contrato de `@crm-lab/shared` usa reto|suave|redondo, entao
 * qualquer valor legado cai no meio-termo `suave` na leitura (D-016).
 */
export function coerceRadiusId(value: string | null | undefined): RadiusId {
  if (value && (RADIUS_IDS as readonly string[]).includes(value)) return value as RadiusId;
  if (value === 'sm') return 'reto';
  if (value === 'lg') return 'redondo';
  return 'suave';
}

export function coerceFontId(value: string | null | undefined): FontId {
  if (value && (FONT_IDS as readonly string[]).includes(value)) return value as FontId;
  return 'figtree';
}

export function mapTheme(row: ThemeRow): Theme {
  return {
    accent: row.accent,
    accent2: row.accent_2,
    bg: row.bg,
    surface: row.surface,
    text: row.text,
    fontId: coerceFontId(row.font_id),
    radiusId: coerceRadiusId(row.radius_id),
    brandName: row.brand_name,
    logoUrl: row.logo_url,
  };
}

const COLUMNS = 'accent, accent_2, bg, surface, text, font_id, radius_id, brand_name, logo_url';

/** Dentro de `withTenant`: o RLS ja restringe a linha do proprio tenant. */
export async function findCurrent(tx: DbTx, tenantId: string): Promise<Theme | null> {
  const result = await tx.query<ThemeRow>(
    `SELECT ${COLUMNS} FROM themes WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  return row ? mapTheme(row) : null;
}

export interface ThemeUpsertInput extends Theme {
  name?: string;
}

/**
 * Cria ou atualiza a linha do tenant. `ON CONFLICT (tenant_id)` usa o indice
 * UNIQUE da migracao 001 — sem race entre dois admins salvando ao mesmo tempo.
 */
export async function upsert(
  tx: DbTx,
  tenantId: string,
  theme: ThemeUpsertInput,
): Promise<Theme> {
  const result = await tx.query<ThemeRow>(
    `INSERT INTO themes (tenant_id, name, accent, accent_2, bg, surface, text,
                         font_id, radius_id, brand_name, logo_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (tenant_id) DO UPDATE SET
       accent = EXCLUDED.accent,
       accent_2 = EXCLUDED.accent_2,
       bg = EXCLUDED.bg,
       surface = EXCLUDED.surface,
       text = EXCLUDED.text,
       font_id = EXCLUDED.font_id,
       radius_id = EXCLUDED.radius_id,
       brand_name = EXCLUDED.brand_name,
       logo_url = EXCLUDED.logo_url
     RETURNING ${COLUMNS}`,
    [
      tenantId,
      theme.name ?? 'Personalizado',
      theme.accent,
      theme.accent2,
      theme.bg,
      theme.surface,
      theme.text,
      theme.fontId,
      theme.radiusId,
      theme.brandName,
      theme.logoUrl,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('UPSERT em themes nao devolveu linha');
  return mapTheme(row);
}
