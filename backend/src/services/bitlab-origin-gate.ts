/**
 * Liga/desliga da proposta que nasce do orcamento do Bitlab (CRMLAB-57, D-196
 * item 1). UMA funcao so, para a regra "Nascer do orcamento do Bitlab" da
 * pagina de Regras (CRMLAB-56) entrar num lugar.
 *
 * Roda dentro da transacao do chunk de ingestao (`db.withTenant` nao aninha):
 * a leitura da regra tem que usar o `tx` recebido.
 */
import type { DbTx } from '../db/types.js';

export async function isBitlabOriginEnabled(_tx: DbTx, _tenantId: string): Promise<boolean> {
  // CRMLAB-56: ler das Regras na integração
  return true;
}
