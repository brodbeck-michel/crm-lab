import type { PresenceEntry } from '@/stores/presence.store';

/**
 * Texto da presença do paciente no cabeçalho da conversa (CRMLAB-67, D-226),
 * igual ao WhatsApp Web. `null` = não mostra nada (fica o telefone): sem
 * presença, ou `offline` sem `lastSeenAt` — o paciente esconde o "visto por
 * último". Hora e dia no fuso do navegador; `now` injetável para teste.
 */
export function presenceLabel(entry: PresenceEntry | null, now: Date): string | null {
  if (!entry) return null;
  switch (entry.presence) {
    case 'typing':
      return 'digitando…';
    case 'recording':
      return 'gravando áudio…';
    case 'online':
      return 'online';
    case 'offline':
      return entry.lastSeenAt ? `visto por último ${lastSeenText(new Date(entry.lastSeenAt), now)}` : null;
  }
}

function lastSeenText(seen: Date, now: Date): string {
  const time = seen.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (seen.getTime() >= startOfToday) return `hoje às ${time}`;
  if (seen.getTime() >= startOfToday - dayMs) return `ontem às ${time}`;
  const date = seen.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  return `${date} às ${time}`;
}
