/**
 * Utilitarios de mapeamento linha-do-banco -> shape de API.
 *
 * Regra de CLAUDE.md §9: datas viajam em ISO 8601 UTC e dinheiro em numero
 * decimal. O driver devolve `Date` (pg/PGlite) ou string, dependendo do tipo —
 * `toIso` normaliza os dois casos num unico ponto.
 */

/** `Date | string | null` -> ISO 8601 UTC (ou `null`). */
export function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value.includes('Z') || value.includes('+') ? value : `${value}Z`);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return null;
}

/** Igual a `toIsoOrNull`, mas para colunas NOT NULL. */
export function toIso(value: unknown): string {
  return toIsoOrNull(value) ?? new Date(0).toISOString();
}

/** JSONB volta como objeto (driver) ou string (fallback). */
export function toJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** NUMERIC/INT chegam como number nos dois drivers; string e defesa em profundidade. */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}
