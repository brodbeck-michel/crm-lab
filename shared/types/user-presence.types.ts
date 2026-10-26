/**
 * Status da atendente (CRMLAB-120, D-286). API_CONTRACTS.md `GET /users/presence`.
 *
 * Não confundir com `PatientPresence` (D-226), que é o paciente no WhatsApp.
 */

/** Status que os outros veem. `offline` = nenhuma aba aberta (o sistema decide). */
export type UserPresenceStatus = 'online' | 'busy' | 'away' | 'offline';

/** O que a própria pessoa pode escolher — `offline` nunca. */
export type SelectableUserPresence = Exclude<UserPresenceStatus, 'offline'>;

export const SELECTABLE_USER_PRESENCE: readonly SelectableUserPresence[] = [
  'online',
  'busy',
  'away',
] as const;

/** Parada sem mexer em nenhuma aba por este tempo → Ausente automático (D-286 item 4). */
export const USER_IDLE_AFTER_MS = 30 * 60 * 1000;

export interface UserPresenceItem {
  userId: string;
  status: UserPresenceStatus;
}

export interface UserPresenceResponse {
  /** Todos os usuários ativos do tenant, com o status efetivo. */
  items: UserPresenceItem[];
  /** O que quem pergunta escolheu (mesmo se o efetivo for `away` por inatividade). */
  myStatus: SelectableUserPresence;
}

/** `PATCH /users/me/presence` — ao menos um campo. */
export interface UpdateMyPresenceRequest {
  status?: SelectableUserPresence;
  idle?: boolean;
}

/**
 * Regra do status efetivo (D-286 item 5). Fica em shared porque é a regra
 * canônica — o backend calcula com ela e os testes conferem contra ela.
 */
export function effectiveUserPresence(input: {
  connected: boolean;
  chosen: SelectableUserPresence;
  idle: boolean;
}): UserPresenceStatus {
  if (!input.connected) return 'offline';
  if (input.chosen === 'away' || input.idle) return 'away';
  return input.chosen;
}
