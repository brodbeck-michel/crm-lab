/**
 * Driver de producao/dev: Postgres real via pool do pacote `pg`.
 */
import pg from 'pg';
import type { DbClient, DbTx, QueryResult, Row } from './types.js';
import { applyTenantContext } from './tenant-context.js';

const { Pool } = pg;

/**
 * `NUMERIC` volta como string no driver `pg` por padrao. Dinheiro no fio e
 * numero decimal (FRONTEND_BACKEND.md "Datas e Dinheiro"), entao convertemos
 * NUMERIC (OID 1700) para Number aqui, uma unica vez, para os dois drivers
 * concordarem.
 */
pg.types.setTypeParser(1700, (value: string) => Number(value));
/** INT8 (bigint) — counts de agregacao cabem em Number com folga. */
pg.types.setTypeParser(20, (value: string) => Number(value));

function wrapClient(client: pg.PoolClient): DbTx {
  return {
    async query<R = Row>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
      const result = await client.query(sql, params as unknown[] | undefined);
      return { rows: result.rows as R[], rowCount: result.rowCount ?? result.rows.length };
    },
    async exec(sql: string): Promise<void> {
      await client.query(sql);
    },
  };
}

export class PgDriver implements DbClient {
  readonly driver = 'pg' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async query<R = Row>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
    const result = await this.pool.query(sql, params as unknown[] | undefined);
    return { rows: result.rows as R[], rowCount: result.rowCount ?? result.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(wrapClient(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* conexao ja perdida — o release abaixo descarta o cliente */
      }
      throw err;
    } finally {
      client.release();
    }
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
    await this.pool.end();
  }
}
