/**
 * Contrato unico de acesso a banco. Dois backends implementam isto (D-008):
 * `PgDriver` (Postgres real, dev/prod) e `PgliteDriver` (testes).
 *
 * Placeholders sao `$1, $2, ...` nos DOIS drivers — SQL escrito uma vez roda
 * nos dois. NUNCA concatene valores em SQL (SECURITY.md, SQL Injection).
 */
export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

export type Row = Record<string, unknown>;

/** Handle de execucao dentro de uma transacao. */
export interface DbTx {
  query<R = Row>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
  /**
   * Executa um script com MULTIPLOS statements e sem parametros
   * (usado por migracoes). Nao aceita parametros de proposito.
   */
  exec(sql: string): Promise<void>;
}

export interface DbClient extends DbTx {
  /** Nome do driver ativo — `pg` ou `pglite`. */
  readonly driver: 'pg' | 'pglite';

  /** Abre transacao crua, SEM contexto de tenant. Prefira `withTenant`. */
  transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;

  /**
   * CAMINHO NORMAL de todo acesso a dados de laboratorio.
   *
   * Camada 3 do isolamento multitenant (docs/architecture/SECURITY.md):
   * abre uma transacao e, ANTES de qualquer outra coisa, executa
   *
   *   SELECT set_config('app.tenant_id', $1, true)   -- true = escopo da TRANSACAO
   *   SET LOCAL ROLE crm_app                          -- role sem BYPASSRLS
   *
   * As policies RLS criadas pelas migracoes comparam `tenant_id` com
   * `current_setting('app.tenant_id', true)`. Como o escopo e local a
   * transacao, o contexto e desfeito no COMMIT/ROLLBACK e NAO vaza entre
   * requisicoes que compartilham a mesma conexao do pool.
   *
   * `crm_app` nao e dono das tabelas, entao o RLS realmente se aplica a ela
   * (o dono e o superusuario ignoram policies).
   */
  withTenant<T>(tenantId: string, fn: (tx: DbTx) => Promise<T>): Promise<T>;

  /**
   * EXCECAO AUDITADA — nao e o caminho normal.
   *
   * Abre transacao SEM `app.tenant_id` e SEM `SET LOCAL ROLE`, portanto sem
   * filtro de RLS. Existe para os dois casos em que o tenant ainda nao e
   * conhecido ou nao se aplica:
   *   1. login (precisa achar o usuario pelo e-mail ANTES de saber o tenant);
   *   2. console de plataforma (`/platform/*`), que opera sobre tenants.
   *
   * Qualquer outro uso e bug de isolamento. Toda chamada deve estar coberta por
   * teste e, quando for acao de operador, gerar audit log.
   */
  withoutTenant<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/** Role de aplicacao criada pelas migracoes (NOLOGIN, sem BYPASSRLS). */
export const APP_DB_ROLE = 'crm_app';

/** GUC lido pelas policies RLS. */
export const TENANT_GUC = 'app.tenant_id';
