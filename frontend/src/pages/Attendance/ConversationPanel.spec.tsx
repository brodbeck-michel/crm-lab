import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationDetail, Message } from '@crm-lab/shared';
import { ConversationPanel } from './ConversationPanel';
import type { ConversationPanelProps } from './ConversationPanel';

/**
 * Rolagem da conversa (PAGES.md §2):
 * mensagem NOVA rola para o fim; histórico ANTIGO mantém a posição de leitura.
 *
 * jsdom não faz layout, então `scrollHeight` é injetado — o que se verifica
 * aqui é a decisão do componente, não o motor de layout do navegador.
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

function message(id: string): Message {
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
  };
}

function props(messages: Message[]): ConversationPanelProps {
  return {
    conversation: CONVERSATION,
    messages,
    isLoading: false,
    isError: false,
    onRetry: vi.fn(),
    onSend: vi.fn(),
    sending: false,
    quickReplies: [],
    assignees: [
      { id: 'u-1', name: 'Marina', role: 'attendant' },
      { id: 'u-2', name: 'Bruno', role: 'manager' },
    ],
    onAssign: vi.fn(),
    onNewBudget: vi.fn(),
    onCloseAttendance: vi.fn(),
    canCloseAttendance: true,
    onToggleContext: vi.fn(),
    onClose: vi.fn(),
    onAttach: vi.fn(),
    contextOpen: true,
    hasOlderMessages: false,
    onLoadOlder: vi.fn(),
  };
}

function stubScrollHeight(element: HTMLElement, value: number): void {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => value });
}

describe('ConversationPanel — rolagem', () => {
  it('mensagem nova rola para o fim; histórico antigo preserva a posição', () => {
    const { rerender } = render(<ConversationPanel {...props([message('m-1'), message('m-2')])} />);
    const scroller = screen.getByTestId('message-scroll');

    // 1) chega uma mensagem NOVA (último id muda) → vai para o fim.
    stubScrollHeight(scroller, 1000);
    rerender(<ConversationPanel {...props([message('m-1'), message('m-2'), message('m-3')])} />);
    expect(scroller.scrollTop).toBe(1000);

    // 2) usuário sobe a leitura e carrega histórico ANTIGO (mesmo último id).
    scroller.scrollTop = 400;
    stubScrollHeight(scroller, 1600);
    rerender(
      <ConversationPanel
        {...props([message('m-0'), message('m-1'), message('m-2'), message('m-3')])}
      />,
    );

    // some a altura acrescentada acima (600), em vez de pular para o fim (1600).
    expect(scroller.scrollTop).toBe(1000);
  });

  it('composer cresceu e a lista encolheu: a borda de baixo fica parada (CRMLAB-49)', () => {
    let notify = (): void => undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    let clientHeight = 500;
    const spy = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(() => clientHeight);

    render(<ConversationPanel {...props([message('m-1'), message('m-2')])} />);
    const scroller = screen.getByTestId('message-scroll');
    scroller.scrollTop = 700;

    // O campo ganhou 40px: a lista perde 40px e sobe o scroll na mesma medida.
    clientHeight = 460;
    act(() => notify());
    expect(scroller.scrollTop).toBe(740);

    // Enviou e o campo voltou a uma linha: devolve os 40px.
    clientHeight = 500;
    act(() => notify());
    expect(scroller.scrollTop).toBe(700);

    spy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('trocar de conversa monta outro Composer — gravação e rascunho não vão para o próximo paciente (D-181)', async () => {
    // Com o mesmo Composer montado, um recado gravado para a Marina seguiria
    // gravando (e seria enviado) depois de abrir a conversa do Bruno.
    const { rerender } = render(<ConversationPanel {...props([message('m1')])} />);
    await userEvent.type(screen.getByLabelText('Mensagem'), 'resposta para a Marina');

    rerender(
      <ConversationPanel
        {...props([message('m1')])}
        conversation={{ ...CONVERSATION, id: 'c-2', patientName: 'Bruno Lima' }}
      />,
    );

    expect(screen.getByLabelText('Mensagem')).toHaveValue('');
  });

  it('conversa encerrada bloqueia composer e o botão Encerrar', () => {
    render(
      <ConversationPanel
        {...props([message('m-1')])}
        conversation={{ ...CONVERSATION, status: 'closed' }}
      />,
    );

    expect(screen.getByLabelText('Mensagem')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Encerrar' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Arquivar' })).not.toBeInTheDocument();
  });

  it('D-174: quem não é dona/gestor/admin vê Encerrar desabilitado', () => {
    render(<ConversationPanel {...props([message('m-1')])} canCloseAttendance={false} />);
    expect(screen.getByRole('button', { name: 'Encerrar' })).toBeDisabled();
    expect(screen.getByLabelText('Mensagem')).toBeEnabled();
  });

  it('D-174: Encerrar chama onCloseAttendance', async () => {
    const onCloseAttendance = vi.fn();
    render(
      <ConversationPanel {...props([message('m-1')])} onCloseAttendance={onCloseAttendance} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Encerrar' }));
    expect(onCloseAttendance).toHaveBeenCalledTimes(1);
  });

  it('oferece carregar mensagens anteriores quando há histórico', () => {
    render(<ConversationPanel {...props([message('m-1')])} hasOlderMessages />);
    expect(
      screen.getByRole('button', { name: 'Carregar mensagens anteriores' }),
    ).toBeInTheDocument();
  });

  it('botão fechar chama onClose (CRMLAB-16)', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ConversationPanel {...props([message('m-1')])} onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Fechar conversa' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('ConversationPanel — menu de transferência', () => {
  it('lista as colegas e "Devolver para a fila", sem quem já é dona da conversa', async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(<ConversationPanel {...props([message('m-1')])} onAssign={onAssign} />);

    await user.click(screen.getByRole('button', { name: 'Transferir' }));

    // A conversa é da Marina (`assignedTo: 'u-1'`): ela não aparece na lista.
    expect(screen.queryByRole('menuitem', { name: 'Marina' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Bruno' }));
    expect(onAssign).toHaveBeenCalledWith('u-2');
  });

  it('devolver para a fila chama onAssign(null)', async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(<ConversationPanel {...props([message('m-1')])} onAssign={onAssign} />);

    await user.click(screen.getByRole('button', { name: 'Transferir' }));
    await user.click(screen.getByRole('menuitem', { name: 'Devolver para a fila' }));
    expect(onAssign).toHaveBeenCalledWith(null);
  });

  it('conversa livre: botão "Atribuir" e nenhuma opção de devolver à fila', async () => {
    const user = userEvent.setup();
    render(
      <ConversationPanel
        {...props([message('m-1')])}
        conversation={{ ...CONVERSATION, assignedTo: null, assignedToName: null }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Atribuir' }));
    expect(screen.getByRole('menuitem', { name: 'Marina' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Devolver para a fila' })).not.toBeInTheDocument();
  });
});
