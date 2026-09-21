import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, SenderType } from '@crm-lab/shared';
import type * as ApiModule from '@/api';

/**
 * `GET /media/:id` exige Authorization — o componente busca via
 * `fetchAuthenticatedBlob` e usa `URL.createObjectURL`, nunca a URL crua
 * direto num `<img src>` (ver `useAuthenticatedMedia`).
 */
const fetchAuthenticatedBlobMock = vi.fn();
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, fetchAuthenticatedBlob: fetchAuthenticatedBlobMock };
});

const { INBOX_BUBBLE_MAX_WIDTH, MESSAGE_BUBBLE_TYPES, MessageBubble, bubbleTypeFor } =
  await import('./MessageBubble');

// O mock acumulava chamadas entre testes: `not.toHaveBeenCalled()` e
// `mock.calls[0]` liam o teste anterior.
beforeEach(() => {
  fetchAuthenticatedBlobMock.mockReset();
});

/**
 * MessageBubble — COMPONENTS.md: TRÊS tipos, nunca mais.
 * O teste existe para que um quarto tipo não entre sem alguém decidir.
 */

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm-1',
    conversationId: 'c-1',
    senderType: 'patient',
    senderId: null,
    senderName: 'João Santos',
    content: 'Quanto custa um hemograma?',
    messageType: 'text',
    attachmentUrl: null,
    status: 'read',
    readAt: null,
    createdAt: '2026-08-23T14:25:00Z',
    ...overrides,
  };
}

describe('MessageBubble', () => {
  it('tem exatamente 3 tipos', () => {
    expect(MESSAGE_BUBBLE_TYPES).toEqual(['received', 'sent', 'system']);
    expect(MESSAGE_BUBBLE_TYPES).toHaveLength(3);
  });

  it('todo senderType da API cai em um dos 3 tipos', () => {
    const senders: SenderType[] = ['patient', 'agent', 'system'];
    const mapped = senders.map(bubbleTypeFor);

    expect(mapped).toEqual(['received', 'sent', 'system']);
    for (const type of mapped) {
      expect(MESSAGE_BUBBLE_TYPES).toContain(type);
    }
  });

  it('recebida encosta à esquerda com o canto apontado embaixo-esquerda', () => {
    render(<MessageBubble type="received" message={message()} />);
    const bubble = screen.getByTestId('message-bubble');

    expect(bubble).toHaveAttribute('data-type', 'received');
    expect(bubble.className).toContain('self-start');
    expect(bubble.className).toContain('rounded-bl-sm');
  });

  it('enviada encosta à direita com o canto apontado embaixo-direita', () => {
    render(
      <MessageBubble
        type="sent"
        message={message({ senderType: 'agent', senderName: 'Marina (Atendente)' })}
      />,
    );
    const bubble = screen.getByTestId('message-bubble');

    expect(bubble).toHaveAttribute('data-type', 'sent');
    expect(bubble.className).toContain('self-end');
    expect(bubble.className).toContain('rounded-br-sm');
  });

  it('evento de sistema é pílula centrada, sem meta e sem largura máxima', () => {
    render(
      <MessageBubble
        type="system"
        message={message({ senderType: 'system', content: 'Orçamento #4776 enviado' })}
      />,
    );
    const bubble = screen.getByTestId('message-bubble');

    expect(bubble).toHaveAttribute('data-type', 'system');
    expect(bubble.className).toContain('self-center');
    expect(bubble.style.maxWidth).toBe('');
    expect(screen.queryByTestId('message-meta')).not.toBeInTheDocument();
  });

  it('largura máxima no inbox é 62% (PAGES.md §2 vence os 78% da regra geral)', () => {
    expect(INBOX_BUBBLE_MAX_WIDTH).toBe('62%');

    render(<MessageBubble type="received" message={message()} />);
    expect(screen.getByTestId('message-bubble').style.maxWidth).toBe('62%');
  });

  /**
   * CRMLAB-31 + revisão do PR #43: `<a href="/api/v1/media/:id">` cru nunca
   * manda Authorization — clicar dava 401 JSON. O componente busca o blob
   * autenticado NO CLIQUE (não na montagem: 30 anexos numa conversa eram 30
   * downloads de até 15 MiB só para desenhar links) e abre em nova aba.
   */
  it('anexo PDF do nosso backend busca o blob autenticado SÓ no clique e abre em nova aba', async () => {
    const user = userEvent.setup();
    URL.createObjectURL = vi.fn(() => 'blob:mock-pdf');
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fetchAuthenticatedBlobMock.mockResolvedValue({
      blob: new Blob(['%PDF-1.4'], { type: 'application/pdf' }),
      fileName: 'pedido.pdf',
    });

    render(
      <MessageBubble
        type="received"
        message={message({ messageType: 'pdf', attachmentUrl: '/api/v1/media/pdf-1' })}
      />,
    );

    // Montou: NADA foi baixado ainda.
    expect(fetchAuthenticatedBlobMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Abrir anexo/ }));

    await waitFor(() => expect(fetchAuthenticatedBlobMock).toHaveBeenCalledTimes(1));
    expect(String(fetchAuthenticatedBlobMock.mock.calls[0]?.[0])).toContain('/api/v1/media/pdf-1');
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    const anchor = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.href).toBe('blob:mock-pdf');
    expect(anchor.target).toBe('_blank');
    expect(anchor.download).toBe('');
    clickSpy.mockRestore();
  });

  /**
   * Anexo genérico (`doc` — inclui o que o backend rebaixou para
   * `application/octet-stream` por MIME fora da allow-list, CRMLAB-31): força
   * download com o nome do Content-Disposition, em vez de renderizar no origin
   * da SPA.
   */
  it('anexo genérico (doc) do nosso backend força download no clique, com o nome original', async () => {
    const user = userEvent.setup();
    URL.createObjectURL = vi.fn(() => 'blob:mock-doc');
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fetchAuthenticatedBlobMock.mockResolvedValue({
      blob: new Blob(['conteudo'], { type: 'application/octet-stream' }),
      fileName: 'documento.html',
    });

    render(
      <MessageBubble
        type="received"
        message={message({ messageType: 'doc', attachmentUrl: '/api/v1/media/doc-1' })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Baixar anexo/ }));
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    const anchor = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.href).toBe('blob:mock-doc');
    expect(anchor.download).toBe('documento.html');
    clickSpy.mockRestore();
  });

  /**
   * Revisão do PR #43: `attachmentUrl` ABSOLUTO de outro host (a URL da Meta que
   * o webhook grava, ou o que vier num POST /messages) NÃO passa pelo fetch
   * autenticado — isso mandava o Bearer do usuário para um terceiro e o CORS
   * ainda bloqueava. Vai como link cru, sem token.
   */
  it('anexo hospedado FORA do nosso backend vira link cru, sem fetch autenticado', () => {
    render(
      <MessageBubble
        type="received"
        message={message({ messageType: 'pdf', attachmentUrl: 'https://arquivo.externo/pedido.pdf' })}
      />,
    );

    expect(fetchAuthenticatedBlobMock).not.toHaveBeenCalled();
    const link = screen.getByRole('link', { name: /Abrir anexo/ });
    expect(link).toHaveAttribute('href', 'https://arquivo.externo/pedido.pdf');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('erro ao buscar o anexo mostra mensagem, e o botão continua para tentar de novo', async () => {
    const user = userEvent.setup();
    fetchAuthenticatedBlobMock.mockRejectedValue(new Error('network'));

    render(
      <MessageBubble
        type="received"
        message={message({ messageType: 'doc', attachmentUrl: '/api/v1/media/doc-2' })}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Baixar anexo/ }));
    await waitFor(() =>
      expect(screen.getByText('Não foi possível carregar o anexo')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Baixar anexo/ })).toBeEnabled();
  });

  it('anexo de imagem busca o blob autenticado e mostra thumbnail; clique abre o lightbox (CRMLAB-15)', async () => {
    const user = userEvent.setup();
    URL.createObjectURL = vi.fn(() => 'blob:mock-image');
    URL.revokeObjectURL = vi.fn();
    fetchAuthenticatedBlobMock.mockResolvedValue({
      blob: new Blob(['fake'], { type: 'image/jpeg' }),
      fileName: 'pedido medico.jpg',
    });

    render(
      <MessageBubble
        type="received"
        message={message({ messageType: 'image', attachmentUrl: '/api/v1/media/img-1' })}
      />,
    );

    expect(screen.queryByRole('link', { name: /Anexo/ })).not.toBeInTheDocument();
    expect(String(fetchAuthenticatedBlobMock.mock.calls[0]?.[0])).toContain('/api/v1/media/img-1');

    const thumbnail = await screen.findByRole('img', { name: 'Anexo enviado na conversa' });
    expect(thumbnail).toHaveAttribute('src', 'blob:mock-image');

    await user.click(thumbnail);
    expect(screen.getByTestId('image-lightbox-backdrop')).toBeInTheDocument();

    // O ↓ salva com o nome que veio no Content-Disposition (CRMLAB-26) — sem
    // isso o arquivo cairia em Downloads como o uuid do blob, sem extensão.
    expect(screen.getByRole('link', { name: 'Baixar imagem' })).toHaveAttribute(
      'download',
      'pedido medico.jpg',
    );

    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByTestId('image-lightbox-backdrop')).not.toBeInTheDocument();
  });

  it('imagem hospedada FORA do nosso backend vai direto no <img>, sem token', () => {
    render(
      <MessageBubble
        type="received"
        message={message({ messageType: 'image', attachmentUrl: 'https://arquivo.externo/foto.jpg' })}
      />,
    );

    expect(fetchAuthenticatedBlobMock).not.toHaveBeenCalled();
    expect(screen.getByRole('img', { name: 'Anexo enviado na conversa' })).toHaveAttribute(
      'src',
      'https://arquivo.externo/foto.jpg',
    );
  });

  it('erro ao buscar a imagem mostra mensagem em vez de thumbnail quebrada', async () => {
    fetchAuthenticatedBlobMock.mockRejectedValue(new Error('network'));

    render(
      <MessageBubble
        type="received"
        message={message({ messageType: 'image', attachmentUrl: '/api/v1/media/img-1' })}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText('Não foi possível carregar a imagem')).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('img', { name: 'Anexo enviado na conversa' }),
    ).not.toBeInTheDocument();
  });

  it('áudio toca na própria bolha, sem link genérico de anexo (CRMLAB-2)', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:mock-audio');
    URL.revokeObjectURL = vi.fn();
    fetchAuthenticatedBlobMock.mockResolvedValue({
      blob: new Blob(['fake'], { type: 'audio/ogg' }),
      fileName: 'recado.ogg',
    });

    render(
      <MessageBubble
        type="received"
        message={message({ messageType: 'audio', attachmentUrl: '/api/v1/media/aud-1' })}
      />,
    );

    expect(screen.queryByRole('link', { name: /Anexo/ })).not.toBeInTheDocument();
    expect(String(fetchAuthenticatedBlobMock.mock.calls[0]?.[0])).toContain('/api/v1/media/aud-1');

    // O blob autenticado vira o `src` do player — nunca a URL crua, que voltaria 401.
    const player = await screen.findByTestId('audio-message-player');
    expect(player).toHaveAttribute('src', 'blob:mock-audio');
    expect(player).toHaveAttribute('controls');
    expect(screen.getByRole('link', { name: 'Baixar áudio' })).toHaveAttribute(
      'href',
      'blob:mock-audio',
    );
  });

  it('erro ao buscar o áudio mostra mensagem em vez de player mudo', async () => {
    fetchAuthenticatedBlobMock.mockRejectedValue(new Error('network'));

    render(
      <MessageBubble
        type="received"
        message={message({ messageType: 'audio', attachmentUrl: '/api/v1/media/aud-1' })}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText('Não foi possível carregar o áudio')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('audio-message-player')).not.toBeInTheDocument();
  });
});
