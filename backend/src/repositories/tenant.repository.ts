/**
 * Acesso a tabela `tenants`.
 *
 * `tenants` esta sob RLS pela coluna `id` (002_row_level_security.sql): dentro
 * de `withTenant(x)` so a linha do proprio tenant e visivel. Nada aqui precisa
 * (nem deve) rodar sem contexto — o login le o tenant junto do usuario, no
 * JOIN de `user.repository.findLoginCandidatesByEmail`.
 */
import type { DbTx } from '../db/types.js';

export interface TenantEntity {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  isActive: boolean;
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  is_active: boolean;
}

function mapTenant(row: TenantRow): TenantEntity {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logoUrl: row.logo_url,
    isActive: row.is_active,
  };
}

/** Dentro de `withTenant`, devolve o proprio tenant (ou null se suspenso/apagado). */
export async function findById(tx: DbTx, id: string): Promise<TenantEntity | null> {
  const result = await tx.query<TenantRow>(
    `SELECT id, name, slug, logo_url, is_active
       FROM tenants
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapTenant(row) : null;
}
