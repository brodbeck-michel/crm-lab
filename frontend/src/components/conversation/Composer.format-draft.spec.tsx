import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth.store';
import { readConversationDraft, useDraftsStore } from '@/stores/drafts.store';
import { Composer } from './Composer';

/** Composer — atalhos de formatação (D-242) e rascunho por conversa (D-243). */

const field = () => screen.getByLabelText('Mensagem') as HTMLTextAreaElement;

describe('Composer — Ctrl+I e Ctrl+Shift+X (D-242)', () => {
  it('Ctrl+I envolve a seleção em `_` e mantém a seleção', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} />);
    await user.type(field(), 'seu resultado saiu');
    field().setSelectionRange(4, 13);
    await user.keyboard('{Control>}i{/Control}');

    expect(field()).toHaveValue('seu _resultado_ saiu');
    await waitFor(() => {
      expect(field().selectionStart).toBe(5);
      expect(field().selectionEnd).toBe(14);
    });
  });

  it('Ctrl+Shift+X envolve em `~`; sem seleção insere `~~` com o cursor no meio', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} />);
    await user.type(field(), 'valor R$ 90');
    field().setSelectionRange(6, 11);
    await user.keyboard('{Control>}{Shift>}X{/Shift}{/Control}');
    expect(field()).toHaveValue('valor ~R$ 90~');

    await user.clear(field());
    await user.type(field(), 'a ');
    await user.keyboard('{Meta>}{Shift>}x{/Shift}{/Meta}');
    expect(field()).toHaveValue('a ~~');
    await waitFor(() => expect(field().selectionStart).toBe(3));
  });

  it('Ctrl+X sem Shift continua sendo recortar (não vira tachado)', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} />);
    await user.type(field(), 'texto');
    field().setSelectionRange(0, 5);
    await user.keyboard('{Control>}x{/Control}');
    expect(field().value).not.toContain('~');
  });

  it('Ctrl+B continua negrito ao lado dos novos', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} />);
    await user.type(field(), 'x');
    field().setSelectionRange(0, 1);
    await user.keyboard('{Control>}b{/Control}');
    expect(field()).toHaveValue('*x*');
  });
});

describe('Composer — rascunho por conversa (D-243)', () => {
  beforeEach(() => {
    localStorage.clear();
    useDraftsStore.setState({ drafts: {} });
    useAuthStore.setState({
      user: { id: 'user-1', email: 'maria@lab.test', name: 'Maria', role: 'attendant', discountLimit: 5 },
    });
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  it('trocar de conversa e voltar: o texto de A continua lá, com o cursor no fim', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Composer key="conv-a" draftId="conv-a" onSend={vi.fn()} />);
    await user.type(field(), 'para a Ana');

    rerender(<Composer key="conv-b" draftId="conv-b" onSend={vi.fn()} />);
    expect(field()).toHaveValue('');
    await user.type(field(), 'para o Beto');

    rerender(<Composer key="conv-a" draftId="conv-a" onSend={vi.fn()} />);
    expect(field()).toHaveValue('para a Ana');
    expect(field().selectionStart).toBe('para a Ana'.length);
    expect(field().selectionEnd).toBe('para a Ana'.length);
    expect(readConversationDraft('conv-b')).toBe('para o Beto');
  });

  it('enviar apaga o rascunho', async () => {
    const user = userEvent.setup();
    render(<Composer draftId="conv-a" onSend={vi.fn()} />);
    await user.type(field(), 'Bom dia!');
    expect(readConversationDraft('conv-a')).toBe('Bom dia!');
    await user.keyboard('{Enter}');
    expect(readConversationDraft('conv-a')).toBeNull();
  });

  it('envio que falha devolve o texto e o rascunho', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn().mockRejectedValue(new Error('409'));
    render(<Composer draftId="conv-a" onSend={onSend} />);
    await user.type(field(), 'Bom dia!');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(field()).toHaveValue('Bom dia!'));
    expect(readConversationDraft('conv-a')).toBe('Bom dia!');
  });

  it('apagar tudo remove o rascunho', async () => {
    const user = userEvent.setup();
    render(<Composer draftId="conv-a" onSend={vi.fn()} />);
    await user.type(field(), 'oi');
    await user.clear(field());
    expect(readConversationDraft('conv-a')).toBeNull();
  });

  it('o `?draft=` do link profundo (`initialValue`) vence o rascunho salvo', () => {
    useDraftsStore.getState().setDraft('user-1', 'conv-a', 'rascunho velho');
    render(<Composer draftId="conv-a" initialValue="Segue o orçamento" onSend={vi.fn()} />);
    expect(field()).toHaveValue('Segue o orçamento');
  });

  it('emoji entra no rascunho também', async () => {
    const user = userEvent.setup();
    render(<Composer draftId="conv-a" onSend={vi.fn()} />);
    await user.type(field(), 'oi ');
    await user.click(screen.getByRole('button', { name: 'Inserir emoji' }));
    await user.click(screen.getByRole('button', { name: 'joinha' }));
    await waitFor(() => expect(readConversationDraft('conv-a')).toBe('oi 👍'));
  });

  it('sem `draftId` (chat interno) nada é guardado', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} />);
    await user.type(field(), 'para a equipe');
    expect(useDraftsStore.getState().drafts).toEqual({});
  });
});
