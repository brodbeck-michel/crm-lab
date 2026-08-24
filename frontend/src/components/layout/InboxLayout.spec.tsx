import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from '@/stores';
import {
  InboxLayout,
  INBOX_CONTEXT_WIDTH,
  INBOX_CONVERSATION_MIN_WIDTH,
  INBOX_LIST_WIDTH,
} from './InboxLayout';

/**
 * InboxLayout — `336px | flex 1 min 440px | 316px recolhível`
 * (COMPONENTS.md `layout/` · DESIGN_TOKENS.md "Inbox").
 */

function renderLayout(props: Partial<React.ComponentProps<typeof InboxLayout>> = {}) {
  return render(
    <InboxLayout
      list={<div>lista</div>}
      conversation={<div>conversa</div>}
      context={<div>contexto</div>}
      {...props}
    />,
  );
}

beforeEach(() => {
  useUIStore.setState({ sidebarCollapsed: false, contextPanelOpen: true, activeModal: null });
});

describe('InboxLayout — larguras do doc', () => {
  it('coluna 1 tem 336px fixos', () => {
    renderLayout();
    const list = screen.getByTestId('inbox-list');
    expect(list).toHaveStyle({ width: `${INBOX_LIST_WIDTH}px` });
    expect(list.style.flex).toBe('0 0 336px');
  });

  it('coluna 2 é flexível COM min-width explícito de 440px', () => {
    renderLayout();
    const conversation = screen.getByTestId('inbox-conversation');
    expect(conversation.style.flex).toBe('1 1 0%');
    expect(conversation).toHaveStyle({ minWidth: `${INBOX_CONVERSATION_MIN_WIDTH}px` });
  });

  it('coluna 3 tem 316px fixos', () => {
    renderLayout();
    const context = screen.getByTestId('inbox-context');
    expect(context).toHaveStyle({ width: `${INBOX_CONTEXT_WIDTH}px` });
    expect(context.style.flex).toBe('0 0 316px');
  });

  it('em tela estreita a LINHA rola no eixo x — as colunas não colapsam', () => {
    renderLayout();
    expect(screen.getByTestId('inbox-layout').className).toContain('overflow-x-auto');
  });
});

describe('InboxLayout — coluna de contexto recolhível', () => {
  it('escondida quando contextPanelOpen é false', () => {
    useUIStore.setState({ contextPanelOpen: false });
    renderLayout();
    expect(screen.queryByTestId('inbox-context')).not.toBeInTheDocument();
    // As outras duas continuam de pé.
    expect(screen.getByTestId('inbox-list')).toBeInTheDocument();
    expect(screen.getByTestId('inbox-conversation')).toBeInTheDocument();
  });

  it('a prop contextOpen sobrepõe o store', () => {
    useUIStore.setState({ contextPanelOpen: true });
    renderLayout({ contextOpen: false });
    expect(screen.queryByTestId('inbox-context')).not.toBeInTheDocument();
  });

  it('sem conteúdo de contexto, a coluna não é renderizada', () => {
    renderLayout({ context: undefined });
    expect(screen.queryByTestId('inbox-context')).not.toBeInTheDocument();
  });
});

describe('InboxLayout — conteúdo', () => {
  it('renderiza as três regiões nomeadas', () => {
    renderLayout();
    expect(screen.getByRole('region', { name: 'Conversas' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Conversa' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Contexto do paciente' })).toBeInTheDocument();
    expect(screen.getByText('lista')).toBeInTheDocument();
    expect(screen.getByText('conversa')).toBeInTheDocument();
    expect(screen.getByText('contexto')).toBeInTheDocument();
  });
});
