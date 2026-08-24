/**
 * Apoio dos testes do console da plataforma.
 *
 * Nao ha factory de `messages` em `tests/helpers/factories.ts` e o faturamento
 * depende da CONTAGEM de mensagens do mes — por isso a insercao direta aqui,
 * com `created_at` explicito para exercitar a janela do mes.
 */
import { randomUUID } from 'node:crypto';
import type { DbClient } from '../../src/db/types.js';
import type { TenantContext } from '../../src/http/context.js';
import type { DbTx, QueryResult, Row } from '../../src/db/types.js';

export function operatorCtx(user: { id: string; tenantId: string }): TenantContext {
  return {
    userId: user.id,
    tenantId: user.tenantId,
    role: 'platform_operator',
    discountLimit: 0,
    ip: '127.0.0.1',
    userAgent: 'vitest',
  };
}

/** Insere N mensagens numa conversa, com data fixa (UTC). */
export async function insertMessages(
  db: DbClient,
  input: {
    tenantId: string;
    conversationId: string;
    count: number;
    createdAt: string;
    content?: string;
  },
): Promise<void> {
  await db.withoutTenant(async (tx) => {
    for (let i = 0; i < input.count; i += 1) {
      await tx.query(
        `INSERT INTO messages (id, tenant_id, conversation_id, sender_type, content, created_at)
         VALUES ($1, $2, $3, 'patient', $4, $5::timestamp)`,
        [
          randomUUID(),
          input.tenantId,
          input.conversationId,
          input.content ?? `mensagem ${i}`,
          input.createdAt,
        ],
      );
    }
  });
}

/**
 * Envelopa o `DbClient` para que a transacao de `withoutTenant` FALHE no
 * primeiro comando que casar com `failOn`.
 *
 * E a unica forma honesta de testar atomicidade: nao adianta afirmar "esta numa
 * transacao" — o teste tem que quebrar o onboarding no meio e conferir que nada
 * sobrou.
 */
export function dbFailingOn(db: DbClient, failOn: RegExp): DbClient {
  const wrapTx = (tx: DbTx): DbTx => ({
    async query<R = Row>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
      if (failOn.test(sql)) throw new Error('falha injetada no meio do onboarding');
      return tx.query<R>(sql, params);
    },
    exec: (sql: string) => tx.exec(sql),
  });

  return {
    driver: db.driver,
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),
    withTenant: (tenantId, fn) => db.withTenant(tenantId, fn),
    withoutTenant: (fn) => db.withoutTenant((tx) => fn(wrapTx(tx))),
    close: () => db.close(),
  };
}
