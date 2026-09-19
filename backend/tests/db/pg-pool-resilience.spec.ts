/**
 * Resiliencia do pool do `pg` (CRMLAB-30, D-137).
 *
 * O que estes testes provam, e por que sem banco de verdade: o defeito do card
 * NAO esta no SQL, esta no `EventEmitter`. Um `Pool` que emite `error` sem
 * nenhum listener faz o Node tratar como excecao nao capturada e MATAR o
 * processo — e isso acontece do lado do driver, antes de qualquer statement.
 * Entao o teste emite o `error` a mao no pool que o `PgDriver` construiu e
 * verifica que nada explode. Um Postgres real nao acrescentaria nada aqui: o
 * `docker restart` do criterio de aceite roda em homologacao, com o Michel.
 *
 * A conexao nunca e aberta: o `pg` so disca no primeiro `connect()`/`query()`,
 * e nenhum destes testes faz isso.
 */
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  PgDriver,
  pgStartupOptions,
} from '../../src/db/pg-driver.js';

/** URL sintatica: nada aqui chega a discar. */
const DSN = 'postgres://user:pass@127.0.0.1:1/crm_lab_test';

/** O `Pool` que o driver criou — o `pg` guarda o ultimo em `new Pool`. */
function poolOf(driver: PgDriver): pg.Pool {
  return (driver as unknown as { pool: pg.Pool }).pool;
}

describe('PgDriver — resiliencia do pool', () => {
  const drivers: PgDriver[] = [];

  function makeDriver(options?: ConstructorParameters<typeof PgDriver>[1]): PgDriver {
    const driver = new PgDriver(DSN, options);
    drivers.push(driver);
    return driver;
  }

  afterEach(async () => {
    // `end()` sem conexao aberta resolve na hora.
    await Promise.all(drivers.splice(0).map((d) => d.close().catch(() => undefined)));
    vi.restoreAllMocks();
  });

  it('tem listener de `error` no pool — um `error` sem listener mataria o processo', () => {
    const pool = poolOf(makeDriver());
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
  });

  it('absorve um `error` do pool sem lancar (queda de conexao ociosa)', () => {
    const pool = poolOf(makeDriver());

    // Exatamente o que o `pg-pool` faz quando uma conexao OCIOSA cai: um
    // restart do Postgres derruba o socket e o `makeIdleListener` repassa
    // `pool.emit('error', err, client)`. Sem o listener do construtor, este
    // `emit` LANCA — e, num emit fora de request, sem ninguem para pegar.
    const err = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });

    expect(() => pool.emit('error', err)).not.toThrow();
  });

  it('nao derruba o processo: nenhum `uncaughtException` e disparado', () => {
    const pool = poolOf(makeDriver());
    // Se o emit lancasse, o Vitest registraria a excecao no processo. Como o
    // emit e sincrono, basta conferir que ele retorna e que havia ouvinte:
    // `emit` devolve `true` quando ALGUEM ouviu o evento.
    expect(pool.emit('error', new Error('connection terminated unexpectedly'))).toBe(true);
  });

  it('aplica os timeouts do pool (conexao ociosa e espera por conexao)', () => {
    const pool = poolOf(makeDriver());
    expect(pool.options.max).toBe(DEFAULT_POOL_MAX);
    expect(pool.options.idleTimeoutMillis).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(pool.options.connectionTimeoutMillis).toBe(DEFAULT_CONNECTION_TIMEOUT_MS);
  });

  it('manda timezone, statement_timeout e idle_in_transaction no pacote de startup', () => {
    const pool = poolOf(makeDriver());
    expect(pool.options.options).toBe(
      '-c timezone=UTC -c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000',
    );
  });

  it('mantem `timezone=UTC` (D-078) mesmo com os timeouts customizados', () => {
    const pool = poolOf(makeDriver({ statementTimeoutMs: 5_000, idleInTransactionTimeoutMs: 0 }));
    expect(pool.options.options).toBe(
      '-c timezone=UTC -c statement_timeout=5000 -c idle_in_transaction_session_timeout=0',
    );
  });

  it('sanea os timeouts: fracao vira inteiro e negativo vira 0 (nada de SQL solto)', () => {
    // Os valores entram INTERPOLADOS no pacote de startup, entao o saneamento
    // e o que garante que um numero nunca vire outra coisa.
    expect(pgStartupOptions(1500.9, -1)).toBe(
      '-c timezone=UTC -c statement_timeout=1500 -c idle_in_transaction_session_timeout=0',
    );
  });
});
