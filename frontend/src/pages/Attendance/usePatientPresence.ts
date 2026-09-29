import { useEffect, useReducer } from 'react';
import { PRESENCE_TTL_MS, presenceFor, usePresenceStore } from '@/stores/presence.store';
import type { PresenceEntry } from '@/stores/presence.store';

/**
 * Presença vigente do paciente da conversa aberta (D-226). Re-renderiza
 * sozinho quando a validade acaba — é o que faz o "digitando…" sumir em 10 s
 * mesmo sem evento novo.
 */
export function usePatientPresence(conversationId: string | null): PresenceEntry | null {
  const entry = usePresenceStore((state) =>
    conversationId ? state.byConversation[conversationId] : undefined,
  );
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const current = presenceFor(entry, Date.now());

  useEffect(() => {
    if (!current) return undefined;
    const ttl = PRESENCE_TTL_MS[current.presence];
    if (!Number.isFinite(ttl)) return undefined;
    const timer = setTimeout(rerender, Math.max(0, current.receivedAt + ttl - Date.now()) + 5);
    return () => clearTimeout(timer);
  }, [current]);

  return current;
}
