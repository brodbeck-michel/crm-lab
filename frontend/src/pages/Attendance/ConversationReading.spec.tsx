import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationDetail, Message, SenderType } from '@crm-lab/shared';
import { dateSeparatorLabel } from '@/components/conversation';
import { ConversationPanel } from './ConversationPanel';
import type { ConversationPanelProps } from './ConversationPanel';

/**
 * Leitura da conversa no padrão WhatsApp Web — CRMLAB-71 (D-238/D-239).
 *
 * jsdom não faz layout. Aqui ele ganha um layout de mentira, mas coerente:
 * cada filho da área rolável tem 100px de altura e fica no topo que a ordem
 * dele manda; a janela visível tem 300px. Assim "a tela não pulou" vira conta
 * verificável: a linha que estava sob os olhos continua à mesma distância do
 * topo da janela depois que o histórico entrou em cima.
 */

const ROW = 100;
const VIEW = 300;

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
  lastMessageAt: '2026-09-28T09:12:00Z',
  tags: [],
  pinned: false,
  customFields: {},
  createdAt: '2026-09-20T10:00:00Z',
};

/** Todas no mesmo dia (um separador só) salvo `createdAt` explícito. */
function message(
  id: string,
  senderType: SenderType = 'patient',
  createdAt = new Date(2026, 8, 28, 9, 0).toISOString(),
): Message {
  return {
    id,
    conversationId: 'c-1',
    senderType,
    senderId: null,
    senderName: senderType === 'patient' ? 'Marina Alves' : null,
    content: `mensagem ${id}`,
    messageType: 'text',
    attachmentUrl: null,
    status: 'read',
    readAt: null,
    createdAt,
  };
}

function range(from: number, to: number): Message[] {
  const list: Message[] = [];
  for (let i = from; i <= to; i += 1) list.push(message(`m-${i}`));
  return list;
}

function props(messages: Message[], extra: Partial<ConversationPanelProps> = {}): ConversationPanelProps {
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
    onSendAttachments: vi.fn(),
    contextOpen: false,
    hasOlderMessages: false,
    loadingOlder: false,
    onLoadOlder: vi.fn(),
    unreadAtOpen: 0,
    ...extra,
  };
}

function scroller(): HTMLElement {
  return screen.getByTestId('message-scroll');
}

function isScroller(element: HTMLElement): boolean {
  return element.dataset.testid === 'message-scroll';
}

/** Topo, na janela, da linha da mensagem `id` (o que a atendente enxerga). */
function visualTop(id: string): number {
  const row = scroller().querySelector<HTMLElement>(`[data-anchor-id="${id}"]`);
  if (!row) throw new Error(`linha ${id} não renderizada`);
  return row.offsetTop - scroller().scrollTop;
}

function jumpButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: /Ir para a última mensagem/ });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 28, 10, 0));

  const position = (element: HTMLElement): number => {
    const parent = element.parentElement;
    return parent ? Array.from(parent.children).indexOf(element) * ROW : 0;
  };
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return position(this);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => ROW);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return isScroller(this) ? VIEW : ROW;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return isScroller(this) ? this.children.length * ROW : ROW;
  });
  // jsdom não implementa `scrollTo` em elemento.
  HTMLElement.prototype.scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number) {
    if (typeof options === 'object' && options.top !== undefined) this.scrollTop = options.top;
  }) as HTMLElement['scrollTo'];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('separador de datas (D-239)', () => {
  it('Hoje, Ontem, dia da semana e data completa nos lugares certos', () => {
    render(
      <ConversationPanel
        {...props([
          message('antiga', 'patient', new Date(2026, 8, 15, 14, 0).toISOString()),
          message('quinta', 'patient', new Date(2026, 8, 24, 8, 30).toISOString()),
          message('quinta-2', 'agent', new Date(2026, 8, 24, 9, 0).toISOString()),
          message('ontem', 'patient', new Date(2026, 8, 27, 23, 59).toISOString()),
          message('hoje', 'patient', new Date(2026, 8, 28, 0, 1).toISOString()),
        ])}
      />,
    );

    const labels = screen.getAllByTestId('date-separator').map((node) => node.textContent);
    // Duas mensagens da quinta: um separador só.
    expect(labels).toEqual(['15/09/2026', 'Quinta-feira', 'Ontem', 'Hoje']);
  });

  it('23h59 e 00h01 ficam em dias diferentes, no fuso local', () => {
    render(
      <ConversationPanel
        {...props([
          message('antes', 'patient', new Date(2026, 8, 26, 23, 59).toISOString()),
          message('depois', 'patient', new Date(2026, 8, 27, 0, 1).toISOString()),
        ])}
      />,
    );

    const children = Array.from(scroller().children);
    const separators = screen.getAllByTestId('date-separator');
    expect(separators.map((node) => node.textContent)).toEqual(['Sábado', 'Ontem']);
    // O segundo separador fica ENTRE as duas mensagens.
    const antes = scroller().querySelector('[data-anchor-id="antes"]');
    const depois = scroller().querySelector('[data-anchor-id="depois"]');
    expect(children.indexOf(separators[1] as Element)).toBeGreaterThan(
      children.indexOf(antes as Element),
    );
    expect(children.indexOf(separators[1] as Element)).toBeLessThan(
      children.indexOf(depois as Element),
    );
  });

  it('regra do rótulo: 7 dias atrás e data futura viram dd/mm/aaaa', () => {
    const now = new Date(2026, 8, 28, 10, 0);
    expect(dateSeparatorLabel(new Date(2026, 8, 28, 0, 0), now)).toBe('Hoje');
    expect(dateSeparatorLabel(new Date(2026, 8, 22, 12, 0), now)).toBe('Terça-feira');
    expect(dateSeparatorLabel(new Date(2026, 8, 21, 12, 0), now)).toBe('21/09/2026');
    expect(dateSeparatorLabel(new Date(2026, 8, 29, 12, 0), now)).toBe('29/09/2026');
    expect(dateSeparatorLabel(new Date(2025, 0, 5, 12, 0), now)).toBe('05/01/2025');
  });
});

describe('faixa de não lidas (D-239)', () => {
  const conversa = [
    message('p-1'),
    message('a-1', 'agent'),
    message('p-2'),
    message('s-1', 'system'),
    message('p-3'),
    message('p-4'),
  ];

  it('abre com "N mensagens não lidas" antes da primeira não lida, rolada nela', () => {
    render(<ConversationPanel {...props(conversa, { unreadAtOpen: 3 })} />);

    const divider = screen.getByTestId('unread-divider');
    expect(divider).toHaveTextContent('3 mensagens não lidas');
    // Só mensagem do PACIENTE conta: a 3ª de trás para frente é a p-2.
    expect(divider.nextElementSibling).toHaveAttribute('data-anchor-id', 'p-2');
    // Rolada na faixa (menos a folga), não no fim.
    expect(scroller().scrollTop).toBe(divider.offsetTop - 16);
    expect(scroller().scrollTop).not.toBe(scroller().scrollHeight);
  });

  it('5 não lidas: faixa "5 mensagens não lidas"; 1 não lida no singular', () => {
    const cinco = range(1, 8);
    const { unmount } = render(<ConversationPanel {...props(cinco, { unreadAtOpen: 5 })} />);
    expect(screen.getByTestId('unread-divider')).toHaveTextContent('5 mensagens não lidas');
    expect(screen.getByTestId('unread-divider').nextElementSibling).toHaveAttribute(
      'data-anchor-id',
      'm-4',
    );
    unmount();

    render(<ConversationPanel {...props(cinco, { unreadAtOpen: 1 })} />);
    expect(screen.getByTestId('unread-divider')).toHaveTextContent('1 mensagem não lida');
  });

  it('mais não lidas do que o carregado: faixa no começo, com o N verdadeiro', () => {
    render(<ConversationPanel {...props(conversa, { unreadAtOpen: 40 })} />);
    const divider = screen.getByTestId('unread-divider');
    expect(divider).toHaveTextContent('40 mensagens não lidas');
    expect(divider.nextElementSibling).toHaveAttribute('data-anchor-id', 'p-1');
  });

  it('sem não lidas: nenhuma faixa e a conversa abre no fim', () => {
    render(<ConversationPanel {...props(conversa)} />);
    expect(screen.queryByTestId('unread-divider')).not.toBeInTheDocument();
    expect(scroller().scrollTop).toBe(scroller().scrollHeight);
  });

  it('mensagem nova não desloca a faixa; a resposta da atendente a remove', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ConversationPanel {...props(conversa, { unreadAtOpen: 2 })} />);
    expect(screen.getByTestId('unread-divider').nextElementSibling).toHaveAttribute(
      'data-anchor-id',
      'p-3',
    );

    rerender(<ConversationPanel {...props([...conversa, message('p-5')], { unreadAtOpen: 2 })} />);
    expect(screen.getByTestId('unread-divider').nextElementSibling).toHaveAttribute(
      'data-anchor-id',
      'p-3',
    );

    await user.type(screen.getByLabelText('Mensagem'), 'Bom dia!{Enter}');
    expect(screen.queryByTestId('unread-divider')).not.toBeInTheDocument();
  });

  it('some ao trocar de conversa', () => {
    const { rerender } = render(<ConversationPanel {...props(conversa, { unreadAtOpen: 2 })} />);
    expect(screen.getByTestId('unread-divider')).toBeInTheDocument();

    rerender(
      <ConversationPanel
        {...props([message('outra')], { unreadAtOpen: 0 })}
        conversation={{ ...CONVERSATION, id: 'c-2' }}
      />,
    );
    expect(screen.queryByTestId('unread-divider')).not.toBeInTheDocument();
  });
});

describe('botão ↓ (D-239)', () => {
  it('no fim não aparece; rolar para cima mostra; mensagem nova não puxa a tela e soma no contador', () => {
    const inicial = range(1, 10);
    const { rerender } = render(<ConversationPanel {...props(inicial)} />);
    expect(jumpButton()).not.toBeInTheDocument();

    // Atendente sobe para ler a m-3.
    scroller().scrollTop = 250;
    fireEvent.scroll(scroller());
    expect(jumpButton()).toBeInTheDocument();
    const lendo = visualTop('m-3');

    rerender(<ConversationPanel {...props([...inicial, message('m-11')])} />);
    expect(visualTop('m-3')).toBe(lendo);
    expect(jumpButton()).toHaveAccessibleName('Ir para a última mensagem (1 nova)');

    rerender(
      <ConversationPanel {...props([...inicial, message('m-11'), message('m-12'), message('m-13')])} />,
    );
    expect(visualTop('m-3')).toBe(lendo);
    const button = jumpButton();
    expect(button).toHaveAccessibleName('Ir para a última mensagem (3 novas)');
    expect(within(button as HTMLElement).getByText('3')).toBeInTheDocument();
  });

  it('clicar desce ao fim com rolagem suave e zera o contador', async () => {
    const user = userEvent.setup();
    const inicial = range(1, 10);
    const { rerender } = render(<ConversationPanel {...props(inicial)} />);
    scroller().scrollTop = 0;
    fireEvent.scroll(scroller());
    rerender(<ConversationPanel {...props([...inicial, message('m-11')])} />);

    await user.click(jumpButton() as HTMLElement);

    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({
      top: scroller().scrollHeight,
      behavior: 'smooth',
    });
    expect(scroller().scrollTop).toBe(scroller().scrollHeight);
    expect(jumpButton()).not.toBeInTheDocument();

    // Voltou a subir: o contador recomeça do zero.
    scroller().scrollTop = 0;
    fireEvent.scroll(scroller());
    expect(jumpButton()).toHaveAccessibleName('Ir para a última mensagem');
  });

  it('perto do fim, mensagem nova desce sozinha', () => {
    const inicial = range(1, 10);
    const { rerender } = render(<ConversationPanel {...props(inicial)} />);
    rerender(<ConversationPanel {...props([...inicial, message('m-11')])} />);
    expect(scroller().scrollTop).toBe(scroller().scrollHeight);
    expect(jumpButton()).not.toBeInTheDocument();
  });

  it('quem envia vai ao fim na hora, mesmo lendo mais acima', async () => {
    const user = userEvent.setup();
    const inicial = range(1, 10);
    const { rerender } = render(<ConversationPanel {...props(inicial)} />);
    scroller().scrollTop = 0;
    fireEvent.scroll(scroller());

    await user.type(screen.getByLabelText('Mensagem'), 'Oi{Enter}');
    rerender(<ConversationPanel {...props([...inicial, message('eu', 'agent')])} />);

    expect(scroller().scrollTop).toBe(scroller().scrollHeight);
    expect(jumpButton()).not.toBeInTheDocument();
  });
});

describe('histórico pela rolagem (D-238)', () => {
  it('perto do topo pede a página anterior e, ao chegar, a tela não pula', () => {
    const onLoadOlder = vi.fn();
    const recentes = range(5, 12);
    const { rerender } = render(
      <ConversationPanel {...props(recentes, { hasOlderMessages: true, onLoadOlder })} />,
    );

    scroller().scrollTop = 150;
    fireEvent.scroll(scroller());
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    const lendo = visualTop('m-5');

    // Buscando: indicador visível e nenhum pedido a mais.
    rerender(
      <ConversationPanel
        {...props(recentes, { hasOlderMessages: true, loadingOlder: true, onLoadOlder })}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Carregando mensagens anteriores…');
    fireEvent.scroll(scroller());
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(visualTop('m-5')).toBe(lendo);

    // Chegaram 4 mais antigas em cima: a m-5 continua no mesmo lugar da janela.
    rerender(
      <ConversationPanel {...props(range(1, 12), { hasOlderMessages: true, onLoadOlder })} />,
    );
    expect(visualTop('m-5')).toBe(lendo);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('mensagem antiga que sai do topo (refetch das páginas) também não faz a tela pular', () => {
    const { rerender } = render(<ConversationPanel {...props(range(1, 10))} />);
    scroller().scrollTop = 450;
    fireEvent.scroll(scroller());
    const lendo = visualTop('m-5');

    rerender(<ConversationPanel {...props([...range(2, 10), message('m-11')])} />);
    expect(visualTop('m-5')).toBe(lendo);
  });

  it('no começo da conversa não pede mais nada', () => {
    const onLoadOlder = vi.fn();
    render(
      <ConversationPanel {...props(range(1, 10), { hasOlderMessages: false, onLoadOlder })} />,
    );

    scroller().scrollTop = 0;
    fireEvent.scroll(scroller());
    fireEvent.scroll(scroller());
    expect(onLoadOlder).not.toHaveBeenCalled();
  });
});
