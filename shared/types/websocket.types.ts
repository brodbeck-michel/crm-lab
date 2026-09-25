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
  | 'internal_chat.new_message'
  | 'channel.connection_changed';

export interface WsEventPayloads {
  'conversation.new_message': { conversationId: string; messageId: string };
  'proposal.status_changed': { proposalId: string; status: string };
  /** Itens, desconto ou medico solicitante mudaram (CRMLAB-12, D-132). */
  'proposal.updated': { proposalId: string };
  'approval.requested': { proposalId: string };
  'approval.decided': { proposalId: string; decision: 'approved' | 'rejected' };
  'internal_chat.new_message': { channelId: string; messageId: string };
  /**
   * Conexao do canal externo mudou (hoje: WhatsApp por QR). `connected: false`
   * e o caso que motivou o evento — ver a nota em `docs/ARCHITECTURE.md`.
   * `requiresNewQr` (D-184): `true` quando o gateway informou `statusReason: 401`
   * — a sessao foi apagada e so um QR novo reconecta. Ausente = `false`.
   */
  'channel.connection_changed': { channel: string; connected: boolean; requiresNewQr?: boolean };
}

export interface WsEvent<E extends WsEventName = WsEventName> {
  event: E;
  data: WsEventPayloads[E];
}

/**
 * Codigo de close do WebSocket quando o cookie de sessao (CRMLAB-33, D-151)
 * falta, e invalido ou expirou no momento do handshake. Faixa 4000-4999 e de
 * uso livre da aplicacao (RFC 6455 §7.4.2) — o servidor SEMPRE completa o
 * handshake (101) antes de fechar com este codigo, porque um upgrade
 * recusado a nivel HTTP (4xx cru) nao expoe o status para o JavaScript do
 * browser (limitacao da API `WebSocket`, nao um detalhe deste projeto) e o
 * cliente perderia o unico sinal que usa para decidir "tento refresh antes
 * de reconectar" em vez de so cair no backoff generico.
 */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/**
 * Codigo de close usado quando o servidor derruba o socket MAIS ANTIGO do
 * mesmo usuario por causa do teto de sockets por usuario (CRMLAB-33).
 *
 * Existe porque `terminate()` chega no browser como 1006 (queda anormal), que
 * o cliente trata como perda de rede e reconecta na hora: com 6 abas abertas,
 * cada reconexao estourava o teto de novo e evictava a proxima mais velha,
 * para sempre — e cada reconexao dispara `invalidateQueries()` naquela aba.
 * Com um codigo proprio, o cliente sabe que a decisao foi do servidor e NAO
 * tenta de novo.
 */
export const WS_CLOSE_TOO_MANY_SOCKETS = 4409;
