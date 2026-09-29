import { create } from 'zustand';
import type { PatientPresence } from '@crm-lab/shared';

/**
 * Presença do paciente (CRMLAB-67, D-226) — efêmera, só em memória (nada em
 * `localStorage`, nada no servidor). Alimentada pelo WS `conversation.presence`
 * (`api/ws.ts`); o cabeçalho da conversa lê com `presenceFor`.
 *
 * Validade (D-226 item 4): `typing`/`recording` 10 s — o "digitando…" some
 * sozinho se o `paused` se perder —, `online` 5 min, `offline` até o próximo
 * evento. Quem lê passa `now`, então a expiração não precisa de timer aqui.
 */

export const PRESENCE_TTL_MS: Record<PatientPresence, number> = {
  typing: 10_000,
  recording: 10_000,
  online: 5 * 60_000,
  offline: Number.POSITIVE_INFINITY,
};

export interface PresenceEntry {
  presence: PatientPresence;
  lastSeenAt: string | null;
  receivedAt: number;
}

export interface PresenceState {
  byConversation: Record<string, PresenceEntry>;
  setPresence: (
    conversationId: string,
    presence: PatientPresence,
    lastSeenAt: string | null,
    receivedAt?: number,
  ) => void;
  clear: () => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  byConversation: {},
  setPresence: (conversationId, presence, lastSeenAt, receivedAt = Date.now()) =>
    set((state) => ({
      byConversation: { ...state.byConversation, [conversationId]: { presence, lastSeenAt, receivedAt } },
    })),
  clear: () => set({ byConversation: {} }),
}));

/** A presença vigente, ou `null` quando expirou ou nunca chegou. */
export function presenceFor(
  entry: PresenceEntry | undefined,
  now: number,
): PresenceEntry | null {
  if (!entry) return null;
  return now - entry.receivedAt < PRESENCE_TTL_MS[entry.presence] ? entry : null;
}
