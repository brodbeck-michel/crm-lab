import { afterEach, describe, expect, it } from 'vitest';
import { presenceFor, usePresenceStore } from './presence.store';
import { presenceLabel } from '@/pages/Attendance/presence-label';

afterEach(() => usePresenceStore.getState().clear());

describe('presença do paciente (D-226)', () => {
  it('digitando vale 10 s; online 5 min; offline não expira', () => {
    const t0 = 1_000_000;
    const set = usePresenceStore.getState().setPresence;
    set('c', 'typing', null, t0);
    const typing = usePresenceStore.getState().byConversation.c;
    expect(presenceFor(typing, t0 + 9_999)).not.toBeNull();
    expect(presenceFor(typing, t0 + 10_000)).toBeNull();

    set('c', 'online', null, t0);
    const online = usePresenceStore.getState().byConversation.c;
    expect(presenceFor(online, t0 + 299_999)).not.toBeNull();
    expect(presenceFor(online, t0 + 300_000)).toBeNull();

    set('c', 'offline', '2026-09-29T17:32:00Z', t0);
    expect(presenceFor(usePresenceStore.getState().byConversation.c, t0 + 86_400_000)).not.toBeNull();
  });

  it('textos no padrão WhatsApp Web', () => {
    const now = new Date(2026, 8, 29, 18, 0);
    const entry = (presence: 'typing' | 'recording' | 'online' | 'offline', lastSeenAt: string | null = null) => ({
      presence,
      lastSeenAt,
      receivedAt: 0,
    });
    expect(presenceLabel(null, now)).toBeNull();
    expect(presenceLabel(entry('typing'), now)).toBe('digitando…');
    expect(presenceLabel(entry('recording'), now)).toBe('gravando áudio…');
    expect(presenceLabel(entry('online'), now)).toBe('online');
    // Escondeu o "visto por último": nada.
    expect(presenceLabel(entry('offline'), now)).toBeNull();
    expect(presenceLabel(entry('offline', new Date(2026, 8, 29, 14, 32).toISOString()), now)).toBe(
      'visto por último hoje às 14:32',
    );
    expect(presenceLabel(entry('offline', new Date(2026, 8, 28, 9, 5).toISOString()), now)).toBe(
      'visto por último ontem às 09:05',
    );
    expect(presenceLabel(entry('offline', new Date(2026, 8, 20, 9, 5).toISOString()), now)).toBe(
      'visto por último 20/09 às 09:05',
    );
  });
});
