import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationDetail, Message } from '@crm-lab/shared';
import { usePresenceStore } from '@/stores/presence.store';
import { COMPOSING_INTERVAL_MS, ConversationPanel } from './ConversationPanel';
import type { ConversationPanelProps } from './ConversationPanel';

/**
 * Painel da conversa — presença do paciente, "digitando…" da atendente e
 * "Tentar de novo" (CRMLAB-67, D-225..D-227).
 */

const CONVERSATION: ConversationDetail = {
  id: 'c-1',
  patientId: 'p-1',
  patientName: 'Marina Alves',
  patientPhone: '(11) 98765-4321',
  patientEmail: null,
  assignedTo: 'u-1',
  assignedToName: 'Marina',
  channel: 'whatsapp',
  status: 'active',
  unreadCount: 0,
  lastMessagePreview: null,
  lastMessageAt: '2026-08-23T09:12:00Z',
  tags: [],
  pinned: false,
  customFields: {},
  createdAt: '2026-08-20T10:00:00Z',
};

function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: 'c-1',
    senderType: 'patient',
    senderId: null,
    senderName: 'Marina Alves',
    content: `mensagem ${id}`,
    messageType: 'text',
    attachmentUrl: null,
    status: 'read',
    readAt: null,
    createdAt: '2026-08-23T09:12:00Z',
    ...overrides,
  };
}

function props(messages: Message[], overrides: Partial<ConversationPanelProps> = {}): ConversationPanelProps {
  return {
    conversation: CONVERSATION,
    messages,
    isLoading: false,
    isError: false,
    onRetry: vi.fn(),
    onSend: vi.fn(),
    sending: false,
    quickReplies: [],
    assignees: [],
    onAssign: vi.fn(),
    onCloseAttendance: vi.fn(),
    canCloseAttendance: true,
    onToggleContext: vi.fn(),
    onClose: vi.fn(),
    onAttach: vi.fn(),
    contextOpen: true,
    hasOlderMessages: false,
    loadingOlder: false,
    onLoadOlder: vi.fn(),
    unreadAtOpen: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  usePresenceStore.getState().clear();
});

describe('ConversationPanel — presença do paciente (D-226)', () => {
  it('"digitando…" aparece no lugar do telefone e some sozinho em 10 s', () => {
    vi.useFakeTimers();
    render(<ConversationPanel {...props([message('m-1')])} />);
    expect(screen.getByTestId('patient-presence')).toHaveTextContent('(11) 98765-4321');

    act(() => usePresenceStore.getState().setPresence('c-1', 'typing', null));
    expect(screen.getByTestId('patient-presence')).toHaveTextContent('digitando…');

    act(() => {
      vi.advanceTimersByTime(10_100);
    });
    expect(screen.getByTestId('patient-presence')).toHaveTextContent('(11) 98765-4321');
  });

  it('presença de OUTRA conversa não aparece nesta', () => {
    render(<ConversationPanel {...props([message('m-1')])} />);
    act(() => usePresenceStore.getState().setPresence('c-outra', 'online', null));
    expect(screen.getByTestId('patient-presence')).toHaveTextContent('(11) 98765-4321');
  });
});

describe('ConversationPanel — presença da atendente (D-227)', () => {
  it('ao abrir manda paused (assina); digitando manda composing no máximo 1 a cada 4 s', () => {
    vi.useFakeTimers();
    const onPresence = vi.fn();
    render(<ConversationPanel {...props([message('m-1')], { onPresence })} />);
    expect(onPresence.mock.calls).toEqual([['paused']]);

    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: 'O' } });
    fireEvent.change(field, { target: { value: 'Ol' } });
    fireEvent.change(field, { target: { value: 'Olá' } });
    expect(onPresence.mock.calls).toEqual([['paused'], ['composing']]);

    act(() => {
      vi.advanceTimersByTime(COMPOSING_INTERVAL_MS);
    });
    fireEvent.change(field, { target: { value: 'Olá!' } });
    expect(onPresence.mock.calls).toEqual([['paused'], ['composing'], ['composing']]);
  });

  it('conversa encerrada não manda presença', () => {
    const onPresence = vi.fn();
    render(
      <ConversationPanel
        {...props([message('m-1')], { onPresence, conversation: { ...CONVERSATION, status: 'closed' } })}
      />,
    );
    expect(onPresence).not.toHaveBeenCalled();
  });
});

describe('ConversationPanel — Tentar de novo (D-227)', () => {
  it('o botão do balão que falhou chama onRetryMessage com o id', async () => {
    const onRetryMessage = vi.fn();
    render(
      <ConversationPanel
        {...props(
          [message('m-9', { senderType: 'agent', senderId: 'u-1', senderName: 'Ana', status: 'failed' })],
          { onRetryMessage },
        )}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(onRetryMessage).toHaveBeenCalledWith('m-9');
  });
});
