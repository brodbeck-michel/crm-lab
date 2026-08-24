/**
 * Driver de teste/dev-sem-Docker: PGlite (Postgres 16 compilado para WASM) — D-008.
 *
 * O pacote `@electric-sql/pglite` e devDependency: ele so entra por `import()`
 * DINAMICO, dentro de `create()`. Assim o bundle/boot de producao nunca tenta
 * resolve-lo. O `import type` do topo e apagado na compilacao.
 */
import type { PGlite, Transaction } from '@electric-sql/pglite';
import type { DbClient, DbTx, QueryResult, Row } from './types.js';
import { applyTenantContext } from './tenant-context.js';

/** NUMERIC e INT8 como Number, igual ao `PgDriver` — dinheiro no fio e decimal. */
const PARSERS: Record<number, (value: string) => unknown> = {
  1700: (value: string) => Number(value),
  20: (value: string) => Number(value),
};

type PgliteQueryable = Pick<Transaction, 'query' | 'exec'>;

function wrap(source: PgliteQueryable): DbTx {
  return {
    async query<R = Row>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
      const result = await source.query<R>(sql, params ? [...params] : undefined);
      const rows = result.rows;
      return { rows, rowCount: rows.length > 0 ? rows.length : (result.affectedRows ?? 0) };
    },
    async exec(sql: string): Promise<void> {
      await source.exec(sql);
    },
  };
}

export class PgliteDriver implements DbClient {
  readonly driver = 'pglite' as const;

  /**
   * PGlite tem UMA conexao. Duas transacoes concorrentes se atropelariam (e o
   * `SET LOCAL ROLE` de uma vazaria para a outra), entao serializamos as
   * transacoes numa fila de promises.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly db: PGlite) {}

  /** Cria a instancia (em memoria por padrao) carregando o pacote sob demanda. */
  static async create(dataDir = 'memory://'): Promise<PgliteDriver> {
    const mod = await import('@electric-sql/pglite');
    const db = await mod.PGlite.create({ dataDir, parsers: PARSERS });
    return new PgliteDriver(db);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Mantem a fila viva mesmo quando a tarefa rejeita.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async query<R = Row>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
    return this.enqueue(() => wrap(this.db).query<R>(sql, params));
  }

  async exec(sql: string): Promise<void> {
    await this.enqueue(() => wrap(this.db).exec(sql));
  }

  async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.enqueue(() =>
      this.db.transaction(async (tx) => {
        return fn(wrap(tx));
      }),
    );
  }

  /** Ver doc do contrato em `types.ts` — camada 3 do isolamento multitenant. */
  async withTenant<T>(tenantId: string, fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.transaction(async (tx) => {
      await applyTenantContext(tx, tenantId);
      return fn(tx);
    });
  }

  /** EXCECAO AUDITADA — sem RLS. Ver doc do contrato em `types.ts`. */
  async withoutTenant<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
