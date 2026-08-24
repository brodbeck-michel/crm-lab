/**
 * Acesso de LEITURA a `proposals` para o AnalyticsService (SERVICES.md §9).
 *
 * ============================================================================
 * "UM NUMERO, UMA ORIGEM" (BUSINESS_RULES.md §5)
 * ============================================================================
 * Nao existe contador materializado, nem coluna `revenue`, nem tabela de
 * agregados. TODA metrica sai de uma agregacao sobre `proposals` feita na
 * query. Se um numero aparece em duas telas, ele veio da mesma expressao SQL
 * daqui.
 *
 * Este arquivo NAO importa o ProposalService: `proposals` e lido em modo
 * somente-leitura, como manda SERVICES.md §9 ("READ-ONLY"). Nenhum INSERT,
 * UPDATE ou DELETE mora aqui — e nao deve passar a morar.
 *
 * ============================================================================
 * AS DUAS JANELAS DE TEMPO — leia antes de mexer
 * ============================================================================
 * Um relatorio de periodo tem duas perguntas diferentes, e elas NAO usam a
 * mesma data:
 *
 *   janela de CRIACAO    (`created_at`) -> funil por estagio, taxa de
 *                                          conversao, motivos de perda
 *   janela de FECHAMENTO (`closed_at`)  -> receita, ticket medio, performers
 *
 * E o que os docs pedem: WORKFLOWS.md §10 define o funil como "contagem por
 * estagio no periodo" e a conversao como "ganhos / total criadas", enquanto
 * BUSINESS_RULES.md §5 calcula receita com `closedAt BETWEEN period`. Sao
 * conjuntos diferentes de propostas de proposito: uma proposta criada em julho
 * e ganha em agosto entra na receita de agosto e no funil de julho.
 *
 * `WON_AT` usa `COALESCE(closed_at, created_at)`: `closed_at` e o valor certo e
 * sempre existe em estagio terminal (invariante do ProposalService e dos
 * seeds), mas se um dado antigo vier sem ele a proposta ganha ainda aparece na
 * receita em vez de sumir silenciosamente (BUSINESS_RULES.md §10).
 *
 * ============================================================================
 * ESCOPO DENTRO DO TENANT
 * ============================================================================
 * Alem do isolamento ENTRE tenants (RLS + filtro explicito), ha permissao
 * DENTRO do tenant: atendente ve so as proprias propostas (`created_by`).
 * O escopo entra no `WHERE` de todas as queries via `scopeClause()` — nunca
 * como filtro em memoria depois.
 */
import type { DbTx } from '../db/types.js';
import { toIso, toNumber } from './row-mappers.js';

/**
 * Recorte de leitura. `userId` presente = "somente as propostas deste usuario"
 * (atendente); ausente = time inteiro (gestor/admin).
 */
export interface AnalyticsScope {
  tenantId: string;
  userId?: string;
}

/**
 * Limites do periodo ja normalizados pelo service: `start` inclusivo,
 * `endExclusive` exclusivo (dia seguinte a `endDate` as 00:00 UTC). Strings no
 * formato `YYYY-MM-DD HH:MM:SS`, comparadas com `::timestamp` — as colunas sao
 * TIMESTAMP sem timezone e o sistema inteiro as trata como UTC.
 */
export interface PeriodBounds {
  start: string;
  endExclusive: string;
}

/** Data que define "ganha/perdida NO periodo". Ver cabecalho. */
const WON_AT = 'COALESCE(p.closed_at, p.created_at)';

/** Monta `WHERE` + params comuns a todas as queries. Sempre filtra tenant. */
function scopeClause(
  scope: AnalyticsScope,
  extra: { column?: string; period?: PeriodBounds } = {},
): { where: string; params: unknown[] } {
  const params: unknown[] = [scope.tenantId];
  const conditions = ['p.tenant_id = $1'];

  if (scope.userId !== undefined) {
    params.push(scope.userId);
    conditions.push(`p.created_by = $${params.length}`);
  }
  if (extra.period && extra.column) {
    params.push(extra.period.start);
    conditions.push(`${extra.column} >= $${params.length}::timestamp`);
    params.push(extra.period.endExclusive);
    conditions.push(`${extra.column} < $${params.length}::timestamp`);
  }
  return { where: `WHERE ${conditions.join(' AND ')}`, params };
}

export interface StatusCount {
  status: string;
  count: number;
}

/** Funil: propostas CRIADAS no periodo, agrupadas pelo estagio ATUAL. */
export async function countByStatusCreatedIn(
  tx: DbTx,
  scope: AnalyticsScope,
  period: PeriodBounds,
): Promise<StatusCount[]> {
  const { where, params } = scopeClause(scope, { column: 'p.created_at', period });
  const result = await tx.query<{ status: string; count: unknown }>(
    `SELECT p.status, COUNT(*)::int AS count
       FROM proposals p
       ${where}
      GROUP BY p.status`,
    params,
  );
  return result.rows.map((row) => ({ status: row.status, count: toNumber(row.count) }));
}

export interface LossReasonCount {
  reason: string | null;
  count: number;
}

/**
 * Motivos de perda das propostas CRIADAS no periodo — mesma janela do funil,
 * para que a soma feche com `funnel.perdido`.
 */
export async function countLossReasonsCreatedIn(
  tx: DbTx,
  scope: AnalyticsScope,
  period: PeriodBounds,
): Promise<LossReasonCount[]> {
  const { where, params } = scopeClause(scope, { column: 'p.created_at', period });
  const result = await tx.query<{ reason_lost: string | null; count: unknown }>(
    `SELECT p.reason_lost, COUNT(*)::int AS count
       FROM proposals p
       ${where} AND p.status = 'perdido'
      GROUP BY p.reason_lost`,
    params,
  );
  return result.rows.map((row) => ({ reason: row.reason_lost, count: toNumber(row.count) }));
}

export interface WonAggregate {
  /** Quantidade de propostas ganhas na janela de fechamento. */
  count: number;
  /** Soma exata dos `total_price` dessas propostas. */
  revenue: number;
}

/** Receita do periodo — a expressao de BUSINESS_RULES.md §5, feita no banco. */
export async function aggregateWonIn(
  tx: DbTx,
  scope: AnalyticsScope,
  period: PeriodBounds,
): Promise<WonAggregate> {
  const { where, params } = scopeClause(scope, { column: WON_AT, period });
  const result = await tx.query<{ count: unknown; revenue: unknown }>(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(p.total_price), 0) AS revenue
       FROM proposals p
       ${where} AND p.status = 'ganho'`,
    params,
  );
  const row = result.rows[0];
  return { count: toNumber(row?.count), revenue: toNumber(row?.revenue) };
}

export interface PerformerRow {
  userId: string;
  name: string;
  conversions: number;
  revenue: number;
}

/** Ranking por receita entre as propostas GANHAS na janela de fechamento. */
export async function topPerformersIn(
  tx: DbTx,
  scope: AnalyticsScope,
  period: PeriodBounds,
  limit: number,
): Promise<PerformerRow[]> {
  const { where, params } = scopeClause(scope, { column: WON_AT, period });
  params.push(limit);
  const result = await tx.query<{
    user_id: string;
    name: string | null;
    conversions: unknown;
    revenue: unknown;
  }>(
    `SELECT p.created_by AS user_id,
            u.name,
            COUNT(*)::int AS conversions,
            COALESCE(SUM(p.total_price), 0) AS revenue
       FROM proposals p
       LEFT JOIN users u ON u.id = p.created_by
       ${where} AND p.status = 'ganho'
      GROUP BY p.created_by, u.name
      ORDER BY revenue DESC, conversions DESC, u.name ASC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    name: row.name ?? 'Usuario removido',
    conversions: toNumber(row.conversions),
    revenue: toNumber(row.revenue),
  }));
}

export interface TeamRow {
  userId: string;
  name: string;
  created: number;
  won: number;
  lost: number;
  revenue: number;
}

/**
 * Uma linha por usuario do laboratorio.
 *
 * As tres contagens usam janelas diferentes de proposito (ver cabecalho), entao
 * cada uma e um `FILTER` sobre a MESMA varredura — nao tres queries que possam
 * divergir. Partimos de `users` com LEFT JOIN, assim quem nao teve movimento no
 * periodo aparece com zeros em vez de sumir da tabela.
 */
export async function teamPerformanceIn(
  tx: DbTx,
  scope: AnalyticsScope,
  period: PeriodBounds,
): Promise<TeamRow[]> {
  const params: unknown[] = [scope.tenantId, period.start, period.endExclusive];
  const createdIn = 'p.created_at >= $2::timestamp AND p.created_at < $3::timestamp';
  const closedIn = `${WON_AT} >= $2::timestamp AND ${WON_AT} < $3::timestamp`;

  const result = await tx.query<{
    user_id: string;
    name: string;
    created: unknown;
    won: unknown;
    lost: unknown;
    revenue: unknown;
  }>(
    `SELECT u.id AS user_id,
            u.name,
            COUNT(p.id) FILTER (WHERE ${createdIn})::int AS created,
            COUNT(p.id) FILTER (WHERE p.status = 'ganho' AND ${closedIn})::int AS won,
            COUNT(p.id) FILTER (WHERE p.status = 'perdido' AND ${closedIn})::int AS lost,
            COALESCE(SUM(p.total_price) FILTER (WHERE p.status = 'ganho' AND ${closedIn}), 0)
              AS revenue
       FROM users u
       LEFT JOIN proposals p
              ON p.created_by = u.id
             AND p.tenant_id = $1
      WHERE u.tenant_id = $1
        AND u.role <> 'platform_operator'
      GROUP BY u.id, u.name
      ORDER BY revenue DESC, created DESC, u.name ASC`,
    params,
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    name: row.name,
    created: toNumber(row.created),
    won: toNumber(row.won),
    lost: toNumber(row.lost),
    revenue: toNumber(row.revenue),
  }));
}

export interface PipelineRow {
  status: string;
  count: number;
  value: number;
}

/** Snapshot: estado ATUAL, sem janela de tempo (SERVICES.md §9). */
export async function pipelineByStatus(
  tx: DbTx,
  scope: AnalyticsScope,
): Promise<PipelineRow[]> {
  const { where, params } = scopeClause(scope);
  const result = await tx.query<{ status: string; count: unknown; value: unknown }>(
    `SELECT p.status, COUNT(*)::int AS count, COALESCE(SUM(p.total_price), 0) AS value
       FROM proposals p
       ${where}
      GROUP BY p.status`,
    params,
  );
  return result.rows.map((row) => ({
    status: row.status,
    count: toNumber(row.count),
    value: toNumber(row.value),
  }));
}

export interface OldestOpenRow {
  id: string;
  status: string;
  createdAt: string;
}

/**
 * Proposta aberta (nao terminal) mais antiga. `null` quando nao ha nenhuma —
 * o campo `oldestProposal` do contrato e nullable justamente por isso.
 *
 * `created_at` sai FORMATADO como ISO-UTC pelo proprio banco, e nao como `Date`.
 * As colunas sao TIMESTAMP sem timezone guardando UTC; se a linha voltasse como
 * `Date`, o driver a interpretaria no fuso da MAQUINA e `daysOpen` mudaria
 * conforme quem roda o processo (em UTC-3 o valor cai um dia). Formatar no SQL
 * e o unico ponto em que essa ambiguidade nao existe.
 */
export async function oldestOpen(
  tx: DbTx,
  scope: AnalyticsScope,
): Promise<OldestOpenRow | null> {
  const { where, params } = scopeClause(scope);
  const result = await tx.query<{ id: string; status: string; created_at: unknown }>(
    `SELECT p.id, p.status,
            to_char(p.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
       FROM proposals p
       ${where} AND p.status NOT IN ('ganho', 'perdido')
      ORDER BY p.created_at ASC, p.id ASC
      LIMIT 1`,
    params,
  );
  const row = result.rows[0];
  return row ? { id: row.id, status: row.status, createdAt: toIso(row.created_at) } : null;
}
