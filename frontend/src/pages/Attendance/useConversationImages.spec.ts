import { describe, expect, it } from 'vitest';
import type { Message } from '@crm-lab/shared';
import { conversationImages, imageCaption, imageTitle } from './useConversationImages';

/** Lista, cabeçalho e legenda do lightbox da conversa (CRMLAB-64, D-244). */

function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: 'c-1',
    senderType: 'patient',
    senderId: null,
    senderName: 'Maria Silva',
    content: '',
    messageType: 'image',
    attachmentUrl: `/api/v1/media/${id}`,
    status: 'read',
    readAt: null,
    createdAt: '2026-09-27T17:32:00Z',
    ...overrides,
  };
}

describe('conversationImages', () => {
  it('só imagem com anexo e não apagada; fora texto, áudio e documento', () => {
    const list = conversationImages([
      message('i-1'),
      message('t-1', { messageType: 'text', attachmentUrl: null }),
      message('a-1', { messageType: 'audio' }),
      message('d-1', { messageType: 'pdf' }),
      message('x-1', { deletedAt: '2026-09-27T18:00:00Z', attachmentUrl: null }),
      message('x-2', { deletedAt: '2026-09-27T18:00:00Z' }),
      message('n-1', { attachmentUrl: null }),
      message('i-2', { senderType: 'agent' }),
    ]);
    expect(list.map((m) => m.id)).toEqual(['i-1', 'i-2']);
  });

  it('ordem cronológica e sem repetir id (janelas que se encostam)', () => {
    const list = conversationImages([
      message('b', { createdAt: '2026-09-27T10:00:00Z' }),
      message('c', { createdAt: '2026-09-27T11:00:00Z' }),
      message('a', { createdAt: '2026-09-27T09:00:00Z' }),
      message('b', { createdAt: '2026-09-27T10:00:00Z' }),
      message('a2', { createdAt: '2026-09-27T09:00:00Z' }),
    ]);
    expect(list.map((m) => m.id)).toEqual(['a', 'a2', 'b', 'c']);
  });
});

describe('imageTitle', () => {
  it('"remetente · dd/mm/aaaa hh:mm"', () => {
    const title = imageTitle(message('i-1'), 'Paciente X');
    expect(title).toMatch(/^Maria Silva · \d{2}\/\d{2}\/2026 \d{2}:\d{2}$/);
  });

  it('sem senderName: paciente pelo nome da conversa, atendente como "Você"', () => {
    expect(imageTitle(message('i-1', { senderName: null }), 'Marina')).toMatch(/^Marina · /);
    expect(imageTitle(message('i-1', { senderName: null }), null)).toMatch(/^Paciente · /);
    expect(
      imageTitle(message('i-1', { senderName: null, senderType: 'agent' }), 'Marina'),
    ).toMatch(/^Você · /);
  });
});

describe('imageCaption', () => {
  it('legenda de verdade aparece aparada', () => {
    expect(imageCaption(message('i', { content: '  Frente do pedido ' }), 'pedido.jpg')).toBe(
      'Frente do pedido',
    );
  });

  it('só o nome do arquivo, vazio ou [image] não é legenda', () => {
    expect(imageCaption(message('i', { content: 'pedido.jpg' }), 'pedido.jpg')).toBeUndefined();
    expect(imageCaption(message('i', { content: '' }), null)).toBeUndefined();
    expect(imageCaption(message('i', { content: '[image]' }), null)).toBeUndefined();
  });
});
