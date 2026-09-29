import { useMemo } from 'react';
import type { Message } from '@crm-lab/shared';
import { formatDateTime } from '@/lib/format';

/**
 * Imagens da conversa para as setas do lightbox (CRMLAB-64, D-244).
 *
 * Sai SÓ das mensagens já carregadas (as páginas do `useInfiniteQuery` no
 * cache, achatadas por `flattenMessages`) — navegar nunca busca histórico.
 * Entra `messageType === 'image'` com anexo e não apagada (D-220). Figurinha
 * ainda chega como `image`; com o tipo `sticker` do CRMLAB-70 ela sai daqui
 * sem mudar este filtro.
 *
 * Ordem cronológica por `(createdAt, id)` e sem repetir id: uma página refeita
 * pelo WS ou uma janela `around` (D-230) encostada noutra não duplica foto.
 */
export function conversationImages(messages: Message[]): Message[] {
  const seen = new Set<string>();
  const images: Message[] = [];
  for (const message of messages) {
    if (message.messageType !== 'image' || !message.attachmentUrl || message.deletedAt) continue;
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    images.push(message);
  }
  return images.sort((a, b) => {
    const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (byTime !== 0) return byTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function useConversationImages(messages: Message[]): Message[] {
  return useMemo(() => conversationImages(messages), [messages]);
}

/**
 * "remetente · dd/mm/aaaa hh:mm". Sem `senderName`: o paciente (ou
 * "Paciente") na recebida, "Você" na enviada — o mesmo fallback do
 * "respondendo a" do Composer.
 */
export function imageTitle(message: Message, patientName: string | null): string {
  const sender =
    message.senderName ??
    (message.senderType === 'patient' ? (patientName ?? 'Paciente') : 'Você');
  const when = formatDateTime(message.createdAt);
  return when ? `${sender} · ${when}` : sender;
}

/** Marcador que a Cloud API grava quando a mídia não tem legenda (`[image]`). */
const PLACEHOLDER = /^\[(?:image|imagem)\]$/i;

/**
 * Legenda da imagem: o `content` aparado — exceto quando ele é só o nome do
 * arquivo (a API grava `content = fileName` quando não houve legenda,
 * D-231/webhook) ou o marcador `[image]`. `undefined` = sem legenda.
 */
export function imageCaption(message: Message, fileName: string | null): string | undefined {
  const text = message.content.trim();
  if (!text || PLACEHOLDER.test(text)) return undefined;
  if (fileName && text === fileName.trim()) return undefined;
  return text;
}
