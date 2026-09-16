/**
 * Eventos WebSocket. FRONTEND_BACKEND.md "Real-time".
 * Regra: evento e NOTIFICACAO, nao transporte de dados — payload carrega so IDs.
 */

export type WsEventName =
  | 'conversation.new_message'
  | 'proposal.status_changed'
  | 'proposal.updated'
  | 'approval.requested'
  | 'approval.decided'
  | 'internal_chat.new_message';

export interface WsEventPayloads {
  'conversation.new_message': { conversationId: string; messageId: string };
  'proposal.status_changed': { proposalId: string; status: string };
  /** Itens, desconto ou medico solicitante mudaram (CRMLAB-12, D-132). */
  'proposal.updated': { proposalId: string };
  'approval.requested': { proposalId: string };
  'approval.decided': { proposalId: string; decision: 'approved' | 'rejected' };
  'internal_chat.new_message': { channelId: string; messageId: string };
}

export interface WsEvent<E extends WsEventName = WsEventName> {
  event: E;
  data: WsEventPayloads[E];
}
