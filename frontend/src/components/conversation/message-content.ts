import type { Message, MessageType } from '@crm-lab/shared';

/** Tipos cujo `content` é só o texto de fallback (busca/prévia) — D-236 item 8. */
const FALLBACK_ONLY: ReadonlySet<MessageType> = new Set(['sticker', 'location', 'contact']);

/**
 * O balão mostra o texto da mensagem? Não quando ele é só o fallback do tipo
 * (figurinha, localização, contato) nem quando a mídia veio sem legenda e o
 * `content` é o próprio nome do arquivo (CRMLAB-70, D-236 item 8).
 */
export function showsMessageText(message: Message): boolean {
  if (FALLBACK_ONLY.has(message.messageType)) return false;
  if (message.attachmentUrl && message.media && message.content === message.media.fileName) {
    return false;
  }
  return message.content.length > 0;
}

/** `65` → `1:05`; `3725` → `1:02:05`. */
export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = String(safe % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}
