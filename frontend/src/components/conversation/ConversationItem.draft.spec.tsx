import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Conversation } from '@crm-lab/shared';
import { useAuthStore } from '@/stores/auth.store';
import { readConversationDraft, useDraftsStore } from '@/stores/drafts.store';
import { ConversationItem } from './ConversationItem';

/** "Rascunho: …" na lista e limpeza de encerrada — D-243. */

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c-1',
    patientId: 'p-1',
    patientName: 'Marina Alves',
    patientPhone: '(11) 98765-4321',
    assignedTo: 'u-1',
    assignedToName: 'Marina',
    channel: 'whatsapp',
    status: 'active',
    unreadCount: 0,
    lastMessagePreview: 'Quanto fica o hemograma?',
    lastMessageAt: '2026-08-23T09:12:00Z',
    tags: [],
    pinned: false,
    createdAt: '2026-08-20T10:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({
    user: { id: 'user-1', email: 'maria@lab.test', name: 'Maria', role: 'attendant', discountLimit: 5 },
  });
  useDraftsStore.setState({ drafts: {} });
  useDraftsStore.getState().setDraft('user-1', 'c-1', 'Fica R$ 90, posso agendar?');
});

afterEach(() => {
  useAuthStore.setState({ user: null });
});

describe('ConversationItem — rascunho', () => {
  it('mostra "Rascunho:" + o texto no lugar da última mensagem', () => {
    render(<ConversationItem conversation={conversation()} />);
    const preview = screen.getByTestId('conversation-preview');
    expect(preview).toHaveTextContent('Rascunho: Fica R$ 90, posso agendar?');
    expect(screen.getByTestId('conversation-draft')).toHaveTextContent('Rascunho:');
    expect(preview).not.toHaveTextContent('hemograma');
  });

  it('a conversa aberta mostra a última mensagem (é ela que está sendo digitada)', () => {
    render(<ConversationItem conversation={conversation()} selected />);
    expect(screen.getByTestId('conversation-preview')).toHaveTextContent('Quanto fica o hemograma?');
    expect(screen.queryByTestId('conversation-draft')).not.toBeInTheDocument();
  });

  it('rascunho de outro usuário não aparece', () => {
    useAuthStore.setState({
      user: { id: 'user-2', email: 'joana@lab.test', name: 'Joana', role: 'attendant', discountLimit: 5 },
    });
    render(<ConversationItem conversation={conversation()} />);
    expect(screen.queryByTestId('conversation-draft')).not.toBeInTheDocument();
  });

  it('conversa encerrada apaga o rascunho e mostra a prévia normal', () => {
    render(<ConversationItem conversation={conversation({ status: 'closed' })} />);
    expect(screen.queryByTestId('conversation-draft')).not.toBeInTheDocument();
    expect(readConversationDraft('c-1')).toBeNull();
  });
});
