/**
 * Acesso a tabela `users`.
 *
 * Todos os metodos recebem um `DbTx` — quem decide o escopo (withTenant /
 * withoutTenant) e o service. O unico metodo que PRECISA rodar fora do RLS e
 * `findLoginCandidatesByEmail`, usado so pelo login (o tenant ainda nao e
 * conhecido); o nome deixa isso explicito.
 */
import type { UserRole } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';
import { toIso, toIsoOrNull, toNumber } from './row-mappers.js';

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  name: string;
  role: string;
  discount_limit_percent: unknown;
  is_active: boolean;
  last_login_at: unknown;
  created_at: unknown;
}

export interface UserEntity {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  name: string;
  role: UserRole;
  discountLimit: number;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

const COLUMNS = `id, tenant_id, email, password_hash, name, role,
                 discount_limit_percent, is_active, last_login_at, created_at`;

export function mapUser(row: UserRow): UserEntity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    passwordHash: row.password_hash,
    name: row.name,
    role: row.role as UserRole,
    discountLimit: toNumber(row.discount_limit_percent),
    isActive: row.is_active,
    lastLoginAt: toIsoOrNull(row.last_login_at),
    createdAt: toIso(row.created_at),
  };
}

/** Linha de `users` + flag de atividade do tenant, para o login. */
export interface LoginCandidate extends UserEntity {
  tenantIsActive: boolean;
  tenantName: string;
  tenantSlug: string;
}

/**
 * EXCECAO DE RLS — chamar SOMENTE dentro de `db.withoutTenant()`.
 *
 * O e-mail e unico por tenant (`UNIQUE (tenant_id, email)`), portanto o mesmo
 * endereco pode existir em mais de um laboratorio. Devolvemos todos os
 * candidatos ordenados; o AuthService escolhe (ativo primeiro, depois o mais
 * antigo) e valida a senha de cada um em ordem.
 */
export async function findLoginCandidatesByEmail(
  tx: DbTx,
  email: string,
): Promise<LoginCandidate[]> {
  const result = await tx.query<UserRow & {
    tenant_is_active: boolean;
    tenant_name: string;
    tenant_slug: string;
  }>(
    `SELECT u.id, u.tenant_id, u.email, u.password_hash, u.name, u.role,
            u.discount_limit_percent, u.is_active, u.last_login_at, u.created_at,
            t.is_active AS tenant_is_active, t.name AS tenant_name, t.slug AS tenant_slug
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
      WHERE LOWER(u.email) = LOWER($1)
        AND t.deleted_at IS NULL
      ORDER BY u.is_active DESC, t.is_active DESC, u.created_at ASC`,
    [email],
  );
  return result.rows.map((row) => ({
    ...mapUser(row),
    tenantIsActive: row.tenant_is_active,
    tenantName: row.tenant_name,
    tenantSlug: row.tenant_slug,
  }));
}

/** Dentro de `withTenant`: o RLS ja garante que so o proprio tenant aparece. */
export async function findById(tx: DbTx, id: string): Promise<UserEntity | null> {
  const result = await tx.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? mapUser(row) : null;
}

export interface ListUsersFilters {
  page: number;
  limit: number;
  search?: string;
  isActive?: boolean;
}

export async function list(
  tx: DbTx,
  filters: ListUsersFilters,
): Promise<{ users: UserEntity[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.search !== undefined && filters.search.trim() !== '') {
    params.push(`%${filters.search.trim()}%`);
    conditions.push(`(name ILIKE $${params.length} OR email ILIKE $${params.length})`);
  }
  if (filters.isActive !== undefined) {
    params.push(filters.isActive);
    conditions.push(`is_active = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalResult = await tx.query<{ count: unknown }>(
    `SELECT COUNT(*)::int AS count FROM users ${where}`,
    params,
  );
  const total = toNumber(totalResult.rows[0]?.count);

  const offset = (filters.page - 1) * filters.limit;
  const pageParams = [...params, filters.limit, offset];
  const result = await tx.query<UserRow>(
    `SELECT ${COLUMNS} FROM users ${where}
      ORDER BY name ASC
      LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    pageParams,
  );

  return { users: result.rows.map(mapUser), total };
}

export interface InsertUserInput {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  name: string;
  role: UserRole;
  discountLimit: number;
}

export async function insert(tx: DbTx, input: InsertUserInput): Promise<UserEntity> {
  const result = await tx.query<UserRow>(
    `INSERT INTO users (id, tenant_id, email, password_hash, name, role,
                        discount_limit_percent, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.email,
      input.passwordHash,
      input.name,
      input.role,
      input.discountLimit,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('INSERT em users nao devolveu linha');
  return mapUser(row);
}

export interface UpdateUserPatch {
  name?: string;
  role?: UserRole;
  discountLimit?: number;
  isActive?: boolean;
}

/**
 * Atualiza campos informados. Devolve `null` quando nenhuma linha foi afetada —
 * id inexistente OU de outro tenant (o RLS esconde). O service converte em 404.
 */
export async function update(
  tx: DbTx,
  id: string,
  patch: UpdateUserPatch,
): Promise<UserEntity | null> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.role !== undefined) {
    params.push(patch.role);
    sets.push(`role = $${params.length}`);
  }
  if (patch.discountLimit !== undefined) {
    params.push(patch.discountLimit);
    sets.push(`discount_limit_percent = $${params.length}`);
  }
  if (patch.isActive !== undefined) {
    params.push(patch.isActive);
    sets.push(`is_active = $${params.length}`);
  }
  if (sets.length === 0) return findById(tx, id);

  params.push(id);
  const result = await tx.query<UserRow>(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${COLUMNS}`,
    params,
  );
  const row = result.rows[0];
  return row ? mapUser(row) : null;
}

export async function touchLastLogin(tx: DbTx, id: string): Promise<void> {
  await tx.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [id]);
}

/**
 * Grava o novo hash de senha (CRMLAB-35, troca própria). Função dedicada, e
 * não um campo a mais em `UpdateUserPatch`: `PATCH /users/:id` é rota de
 * admin editando OUTRO usuário — misturar senha ali abriria um caminho de
 * reset de senha por admin que não existe hoje (o único reset de terceiro é
 * `platform.routes.ts`, fora do escopo deste card).
 */
export async function updatePasswordHash(
  tx: DbTx,
  id: string,
  passwordHash: string,
  expectedCurrentHash?: string,
): Promise<boolean> {
  // `expectedCurrentHash` e compare-and-set (CRMLAB-35, revisao do PR #49): a
  // troca de senha confere a senha atual FORA da transacao (bcrypt custa ~300ms
  // e nao pode segurar conexao do pool), entao a janela entre conferir e gravar
  // existe. Com o hash antigo no WHERE, duas trocas concorrentes nao se
  // sobrescrevem: a segunda nao acha linha e volta como "senha atual incorreta".
  if (expectedCurrentHash !== undefined) {
    const result = await tx.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2 AND password_hash = $3',
      [passwordHash, id, expectedCurrentHash],
    );
    return result.rowCount > 0;
  }
  const result = await tx.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
    passwordHash,
    id,
  ]);
  return result.rowCount > 0;
}
