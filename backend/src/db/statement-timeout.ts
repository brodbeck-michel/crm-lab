/**
 * Valvula de escape do `statement_timeout` global (CRMLAB-30, D-135).
 *
 * `PgDriver` fixa `statement_timeout=30s` no pacote de startup, para que uma
 * query lenta nao segure uma das 10 conexoes do pool para sempre. Isso e certo
 * para request de usuario e errado para as poucas operacoes que sao LONGAS POR
 * NATUREZA — hoje, as migracoes.
 *
 * `SET LOCAL` vale ate o fim da TRANSACAO corrente e e desfeito no
 * COMMIT/ROLLBACK, igual ao `SET LOCAL ROLE` de `tenant-context.ts`. Como a
 * conexao volta para o pool com o valor da sessao, nao ha risco de a isencao
 * vazar para a proxima requisicao que pegar a mesma conexao — que e
 * exatamente o motivo de usar `SET LOCAL` e nao `SET`.
 *
 * Use com parcimonia: cada chamada e uma conexao do pool que pode ficar presa
 * por mais tempo. A pergunta certa quase sempre nao e "quanto timeout a mais",
 * e sim "por que este statement demora tanto".
 */
import type { DbTx } from './types.js';

/** Sem limite. So para trabalho de operador/deploy, nunca em request. */
export const NO_STATEMENT_TIMEOUT = 0;

/**
 * Ajusta o `statement_timeout` DESTA transacao.
 *
 *   await db.transaction(async (tx) => {
 *     await setStatementTimeout(tx, NO_STATEMENT_TIMEOUT);
 *     await tx.exec(migracaoComCreateIndexGigante);
 *   });
 *
 * `SET` nao aceita parametro de bind (`$1`) no Postgres, entao o valor entra
 * interpolado — por isso passa por `Math.trunc` e o piso em 0, que fecham a
 * unica porta de injecao: um `number` saneado nunca vira SQL.
 */
export async function setStatementTimeout(tx: DbTx, ms: number): Promise<void> {
  const value = Math.max(0, Math.trunc(ms));
  await tx.query(`SET LOCAL statement_timeout = ${value}`);
}
