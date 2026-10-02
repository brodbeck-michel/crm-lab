/**
 * Assumir uma conversa da FILA LIVRE — a unica implementacao (CRMLAB-75, D-215).
 *
 * Dois caminhos assumem conversa sem dona:
 *   - o botao "Assumir" (`ConversationService.assign`, `PATCH /conversations/:id`)
 *   - responder a conversa (`MessageService.claimForAgent`, antes do INSERT)
 *
 * Os dois passam por aqui para a corrida ter UMA regra: quem decide e o banco,
 * `UPDATE ... WHERE assigned_to IS NULL` (`claimIfUnassigned`). Quem afetar 0
 * linhas perdeu e recebe `CONVERSATION_ALREADY_ASSIGNED` com o nome de quem
 * ganhou — e a informacao que a tela mostra ("Ana ja assumiu esta conversa").
 *
 * A auditoria (`assign_conversation`) fica com quem chama: o botao tem
 * `TenantContext` (ip/userAgent, `audit.record`); o envio de mensagem so tem
 * tenant + autor (`audit.log`). O shape do registro e o mesmo nos dois.
 */
import type { ConversationDetail } from '@crm-lab/shared';
import { BusinessError } from '../http/errors.js';
import type { ConversationRepository } from '../repositories/conversation.repository.js';

type ClaimRepository = Pick<ConversationRepository, 'claimIfUnassigned' | 'findById'>;

/**
 * Atribui a conversa livre a `userId`. Devolve a conversa ja atribuida e
 * `claimed` (`false` = outro envio da mesma pessoa chegou antes: nada a
 * auditar de novo). Lanca `CONVERSATION_ALREADY_ASSIGNED` se OUTRA pessoa pegou
 * entre a leitura e o UPDATE.
 */
export async function claimFreeConversation(
  repository: ClaimRepository,
  tenantId: string,
  conversationId: string,
  userId: string,
): Promise<{ conversation: ConversationDetail; claimed: boolean }> {
  const claimed = await repository.claimIfUnassigned(tenantId, conversationId, userId);
  if (claimed) return { conversation: claimed, claimed: true };
  const winner = await repository.findById(tenantId, conversationId);
  // Dois envios da MESMA pessoa (duplo Enter, texto + anexo) disputam entre si:
  // o segundo "perde" para ela mesma, o que nao e conflito.
  if (winner && winner.assignedTo === userId) return { conversation: winner, claimed: false };
  throw new BusinessError('CONVERSATION_ALREADY_ASSIGNED', {
    assignedTo: winner?.assignedTo ?? null,
    assignedToName: winner?.assignedToName ?? null,
  });
}
