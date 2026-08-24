/**
 * Acesso a `tenants` (e a agregados por tenant) para o console da plataforma.
 *
 * ============================================================================
 * ESTE E O UNICO REPOSITORIO QUE CRUZA TENANTS — leia antes de acrescentar algo
 * ============================================================================
 * Todo metodo daqui roda dentro de `db.withoutTenant()`, a excecao auditada
 * documentada em `src/db/types.ts` e na migracao 002. Sem `app.tenant_id` nao
 * ha filtro de RLS, entao a barreira de isolamento neste caminho e o proprio
 * codigo. Por isso duas regras valem aqui e em nenhum outro lugar:
 *
 *  1. So o `PlatformService` chama este arquivo, e so depois de exigir
 *     `platform_operator`.
 *  2. NENHUMA query devolve dado de laboratorio. Nada de `conversations`,
 *     `messages.content`, `patient_name`, `internal_messages` ou linha de
 *     proposta. O que sai daqui e cadastro do tenant + CONTAGEM agregada.
 *     PAGES.md §11 e SECURITY.md tratam isso como requisito, nao configuracao.
 *
 * As contagens de `messages` e `proposals` existem porque a tela "Assinaturas &
 * Uso" precisa de excedente de mensagens e volume — mas sao `COUNT(*)`, jamais
 * `SELECT content`. Uma query nova que projete coluna de conteudo e um bug de
 * privacidade, ainda que o teste de tipo passe.
 */
import { randomUUID } from 'node:crypto';
import type { DbTx } from '../db/types.js';
import { toIso, toIsoOrNull, toNumber } from './row-mappers.js';

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  subscription_plan: string | null;
  subscription_until: unknown;
  user_count: unknown;
  created_at: unknown;
}

export interface TenantSummaryEntity {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  subscriptionPlan: string;
  subscriptionUntil: string | null;
  userCount: number;
  createdAt: string;
}

function mapTenant(row: TenantRow): TenantSummaryEntity {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    isActive: row.is_active,
    subscriptionPlan: row.subscription_plan ?? 'starter',
    // DATE puro: fica em YYYY-MM-DD, sem hora (IsoDate do contrato).
    subscriptionUntil: toIsoOrNull(row.subscription_until)?.slice(0, 10) ?? null,
    userCount: toNumber(row.user_count),
    createdAt: toIso(row.created_at),
  };
}

export interface ListTenantsCriteria {
  page: number;
  limit: number;
  search?: string;
  isActive?: boolean;
  plan?: string;
}

function listConditions(criteria: ListTenantsCriteria): {
  where: string;
  params: unknown[];
} {
  const params: unknown[] = [];
  const conditions = ['t.deleted_at IS NULL'];

  if (criteria.search !== undefined && criteria.search !== '') {
    params.push(`%${criteria.search}%`);
    conditions.push(`(t.name ILIKE $${params.length} OR t.slug ILIKE $${params.length})`);
  }
  if (criteria.isActive !== undefined) {
    params.push(criteria.isActive);
    conditions.push(`t.is_active = $${params.length}`);
  }
  if (criteria.plan !== undefined) {
    params.push(criteria.plan);
    conditions.push(`t.subscription_plan = $${params.length}`);
  }
  return { where: `WHERE ${conditions.join(' AND ')}`, params };
}

export async function countTenants(tx: DbTx, criteria: ListTenantsCriteria): Promise<number> {
  const { where, params } = listConditions(criteria);
  const result = await tx.query<{ count: unknown }>(
    `SELECT COUNT(*)::int AS count FROM tenants t ${where}`,
    params,
  );
  return toNumber(result.rows[0]?.count);
}

/**
 * Pagina de laboratorios clientes. `user_count` sai de uma subquery agregada —
 * quantidade de contas, nunca a lista de pessoas.
 */
export async function listTenants(
  tx: DbTx,
  criteria: ListTenantsCriteria,
): Promise<TenantSummaryEntity[]> {
  const { where, params } = listConditions(criteria);
  const offset = (criteria.page - 1) * criteria.limit;
  const pageParams = [...params, criteria.limit, offset];

  const result = await tx.query<TenantRow>(
    `SELECT t.id, t.name, t.slug, t.is_active, t.subscription_plan, t.subscription_until,
            t.created_at,
            (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id) AS user_count
       FROM tenants t
       ${where}
      ORDER BY t.created_at DESC, t.name ASC
      LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );
  return result.rows.map(mapTenant);
}

export async function findTenantById(
  tx: DbTx,
  id: string,
): Promise<TenantSummaryEntity | null> {
  const result = await tx.query<TenantRow>(
    `SELECT t.id, t.name, t.slug, t.is_active, t.subscription_plan, t.subscription_until,
            t.created_at,
            (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id) AS user_count
       FROM tenants t
      WHERE t.id = $1 AND t.deleted_at IS NULL`,
    [id],
  );
  const row = result.rows[0];
  return row ? mapTenant(row) : null;
}

/** `slug` e UNIQUE no schema; isto e a checagem amigavel ANTES do INSERT. */
export async function slugExists(tx: DbTx, slug: string): Promise<boolean> {
  const result = await tx.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM tenants WHERE slug = $1) AS exists',
    [slug],
  );
  return result.rows[0]?.exists === true;
}

export interface InsertTenantInput {
  id?: string;
  name: string;
  slug: string;
  plan: string;
}

export async function insertTenant(tx: DbTx, input: InsertTenantInput): Promise<string> {
  const id = input.id ?? randomUUID();
  await tx.query(
    `INSERT INTO tenants (id, name, slug, subscription_plan, is_active)
     VALUES ($1, $2, $3, $4, TRUE)`,
    [id, input.name, input.slug, input.plan],
  );
  return id;
}

/** Canal interno padrao do onboarding (WORKFLOWS.md §7 passo 2). */
export async function insertChannel(
  tx: DbTx,
  tenantId: string,
  key: string,
  name: string,
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO internal_channels (id, tenant_id, key, name, kind)
     VALUES ($1, $2, $3, $4, 'channel')`,
    [id, tenantId, key, name],
  );
  return id;
}

export interface BillingRow {
  tenantId: string;
  tenantName: string;
  plan: string;
  isActive: boolean;
  messagesUsed: number;
  proposalCount: number;
}

/**
 * Uma linha por tenant com os DOIS agregados que a tela de assinatura usa.
 *
 * `messages_used` conta as mensagens do mes corrente (janela recebida ja
 * normalizada em UTC) e `proposal_count` conta as propostas do tenant. Sao
 * `COUNT(*)` em subqueries: nenhuma coluna de conteudo entra no SELECT, e nao
 * ha JOIN que pudesse arrastar `patient_name` para a resposta.
 */
export async function billingUsage(
  tx: DbTx,
  month: { start: string; endExclusive: string },
): Promise<BillingRow[]> {
  const result = await tx.query<{
    id: string;
    name: string;
    subscription_plan: string | null;
    is_active: boolean;
    messages_used: unknown;
    proposal_count: unknown;
  }>(
    `SELECT t.id, t.name, t.subscription_plan, t.is_active,
            (SELECT COUNT(*)::int FROM messages m
              WHERE m.tenant_id = t.id
                AND m.created_at >= $1::timestamp
                AND m.created_at < $2::timestamp) AS messages_used,
            (SELECT COUNT(*)::int FROM proposals p WHERE p.tenant_id = t.id) AS proposal_count
       FROM tenants t
      WHERE t.deleted_at IS NULL
      ORDER BY t.name ASC`,
    [month.start, month.endExclusive],
  );

  return result.rows.map((row) => ({
    tenantId: row.id,
    tenantName: row.name,
    plan: row.subscription_plan ?? 'starter',
    isActive: row.is_active,
    messagesUsed: toNumber(row.messages_used),
    proposalCount: toNumber(row.proposal_count),
  }));
}
