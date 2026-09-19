/**
 * Driver de producao/dev: Postgres real via pool do pacote `pg`.
 */
import pg from 'pg';
import { logger } from '../lib/logger.js';
import type { DbClient, DbTx, QueryResult, Row } from './types.js';
import { applyTenantContext } from './tenant-context.js';

const { Pool } = pg;

/**
 * Conexoes simultaneas. Mantido em 10 (era o valor anterior): a VPS tem 2 vCPU
 * e o `max_connections` do Postgres e compartilhado com hml.
 */
export const DEFAULT_POOL_MAX = 10;

/**
 * Fecha conexao ociosa (CRMLAB-30). Sem isto o pool guarda ate 10 conexoes
 * abertas para sempre depois de um pico, e cada uma e um processo do lado do
 * Postgres. 30 s e curto o bastante para devolver o recurso e longo o bastante
 * para nao reabrir conexao a cada request em horario de atendimento.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * Espera por uma conexao livre. Sem isto, com o pool esgotado (ou o Postgres
 * fora do ar), `pool.connect()` espera INDEFINIDAMENTE e as requisicoes so se
 * empilham: o backend parece travado em vez de responder erro. 5 s converte
 * "trava" em "500 rapido", que o cliente e o healthcheck sabem tratar.
 */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * `statement_timeout` da SESSAO. Corta a query lenta que segura uma das 10
 * conexoes. Na VPS estava em 0 (sem limite) — confirmado em 19/09/2026.
 *
 * 30 s e MUITO acima de qualquer consulta legitima do CRM (a mais pesada, o
 * analytics, e paginada e cacheada). As duas rotas candidatas a estourar foram
 * revisadas e nao estouram:
 *   - IMPORT LIS: ja roda em chunks, uma transacao por chunk e um upsert de UMA
 *     linha por statement (`lis-import.service.ts`, SERVICES.md §19). O tempo
 *     TOTAL do import pode passar de 30 s; nenhum STATEMENT passa — e o
 *     `statement_timeout` conta por statement, nao por transacao.
 *   - EXPORT Excel: nao existe. O unico uso de `exceljs` e LEITURA de planilha
 *     no import (`lib/lis-spreadsheet.ts`), fora do banco.
 * O que sobra sao as MIGRACOES, que rodam pelo mesmo driver e podem ter um
 * unico `CREATE INDEX`/`ALTER TABLE` longo. Migracao morta no meio de um deploy
 * e o pior desfecho possivel, entao o migrator se isenta com
 * `SET LOCAL statement_timeout = 0` (ver `statement-timeout.ts`).
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * `idle_in_transaction_session_timeout` da SESSAO. Tambem estava em 0 na VPS.
 *
 * Mata a transacao ABERTA e parada — o caso do incidente de 17/09, em que o
 * `withTenant` ficava aberto esperando o gateway Evolution responder. Uma
 * transacao nessas condicoes nao segura so a conexao: ela tambem trava o
 * `VACUUM` das tabelas que tocou.
 *
 * 60 s (o dobro do `statement_timeout`) de proposito: a transacao mais longa e
 * a do chunk do import LIS, que encadeia varios statements curtos. O limite
 * precisa perdoar a soma deles e punir so a espera de verdade.
 */
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

export interface PgDriverOptions {
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  /** `statement_timeout` da sessao, em ms. `0` desliga. */
  statementTimeoutMs?: number;
  /** `idle_in_transaction_session_timeout` da sessao, em ms. `0` desliga. */
  idleInTransactionTimeoutMs?: number;
}

/** Inteiro >= 0 — estes valores entram por interpolacao no pacote de startup. */
function nonNegativeInt(value: number): number {
  return Math.max(0, Math.trunc(value));
}

/**
 * Pacote de startup da conexao: vale para TODA conexao do pool, sem round-trip
 * extra por checkout. Exportado para o teste conferir a string exata — errar
 * aqui e um defeito silencioso (o Postgres aceita a conexao e ignora o que nao
 * entendeu apenas em alguns casos; em outros a conexao nem sobe).
 */
export function pgStartupOptions(
  statementTimeoutMs: number,
  idleInTransactionTimeoutMs: number,
): string {
  return [
    '-c timezone=UTC',
    `-c statement_timeout=${nonNegativeInt(statementTimeoutMs)}`,
    `-c idle_in_transaction_session_timeout=${nonNegativeInt(idleInTransactionTimeoutMs)}`,
  ].join(' ');
}

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

  /**
   * `options` fixa parametros da SESSAO do banco no pacote de startup — vale
   * para toda conexao do pool, sem round-trip:
   *
   * - `timezone=UTC` (D-078): sem isso o fuso vem do servidor,
   *   `NOW() - <coluna TIMESTAMP sem tz>` converte a coluna pelo fuso da sessao
   *   e um servidor em `America/Sao_Paulo` devolveria os tempos de espera
   *   10.800 s errados (mesmo defeito de D-021).
   * - `statement_timeout` e `idle_in_transaction_session_timeout` (CRMLAB-30,
   *   D-135): ver as constantes acima.
   *
   * O `pool.on('error')` e o ponto do card: o `pg` emite `error` NO POOL quando
   * uma conexao OCIOSA cai (restart do Postgres, corte de rede, o
   * `idle_in_transaction_session_timeout` acima). Um `EventEmitter` que emite
   * `error` sem nenhum listener lanca a excecao, e como isso acontece fora de
   * qualquer request nao ha `try/catch` no caminho: o Node derruba o PROCESSO.
   * Um restart do Postgres virava, assim, queda do backend inteiro — todos os
   * WebSockets de todos os tenants, e o container reiniciando.
   *
   * O listener nao precisa fazer nada alem de LOGAR: o proprio `pg` ja descarta
   * a conexao quebrada do pool, e a proxima query abre outra. Logar e o que
   * transforma um mistério em uma linha de diagnostico.
   */
  constructor(connectionString: string, options: PgDriverOptions = {}) {
    this.pool = new Pool({
      connectionString,
      max: options.max ?? DEFAULT_POOL_MAX,
      idleTimeoutMillis: options.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      options: pgStartupOptions(
        options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
        options.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      ),
    });

    this.pool.on('error', (err: Error) => {
      logger.error('db.pool_error', {
        message: err.message,
        code: 'code' in err ? String(err.code) : undefined,
      });
    });
  }

  async query<R = Row>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
    const result = await this.pool.query(sql, params as unknown[] | undefined);
    return { rows: result.rows as R[], rowCount: result.rowCount ?? result.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  /**
   * O `pool.on('error')` do construtor NAO cobre este caminho (CRMLAB-30).
   *
   * O `pg-pool` instala o proprio listener de `error` so enquanto a conexao
   * esta OCIOSA no pool: `_acquireClient` faz `client.removeListener('error',
   * idleListener)` no checkout e `_release` o recoloca. Ou seja, no intervalo
   * em que a transacao esta aberta a conexao fica SEM listener nenhum — e se
   * ela cair exatamente ai (o Postgres reiniciou, a rede piscou, o
   * `idle_in_transaction_session_timeout` derrubou a sessao), o `error` do
   * `EventEmitter` volta a matar o processo, como se o listener do pool nao
   * existisse.
   *
   * A janela nao e teorica: `withTenant` mantem a transacao aberta durante
   * TODO o corpo do handler, inclusive enquanto ele espera um gateway externo
   * — o cenario do incidente de 17/09.
   *
   * O listener SAI antes do `release()`: se ficasse, o `pg` somaria o dele por
   * cima a cada checkout e a conexao acumularia listeners ate o aviso de
   * `MaxListenersExceeded`.
   */
  async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const onClientError = (err: Error): void => {
      logger.error('db.client_error', {
        message: err.message,
        code: 'code' in err ? String(err.code) : undefined,
      });
    };
    client.on('error', onClientError);
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
      client.removeListener('error', onClientError);
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
