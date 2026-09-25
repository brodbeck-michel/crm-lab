import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

/** Composer — COMPONENTS.md: Enter envia, Shift+Enter quebra linha. */

describe('Composer', () => {
  it('Enter envia a mensagem e limpa o campo', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    const field = screen.getByLabelText('Mensagem');
    await userEvent.type(field, 'Bom dia!');
    await userEvent.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalledWith('Bom dia!');
    expect(field).toHaveValue('');
  });

  it('Shift+Enter NAO envia — quebra linha', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    const field = screen.getByLabelText('Mensagem');
    await userEvent.type(field, 'primeira linha');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    await userEvent.type(field, 'segunda linha');

    expect(onSend).not.toHaveBeenCalled();
    expect(field).toHaveValue('primeira linha\nsegunda linha');
  });

  it('o botão enviar dispara o mesmo caminho, com o texto aparado', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    await userEvent.type(screen.getByLabelText('Mensagem'), '   olá   ');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(onSend).toHaveBeenCalledWith('olá');
  });

  it('campo vazio não envia', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);

    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('conversa arquivada: composer bloqueado', () => {
    render(<Composer onSend={vi.fn()} disabled />);

    expect(screen.getByLabelText('Mensagem')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  });

  it('botão de anexo só existe quando há handler', () => {
    const { rerender } = render(<Composer onSend={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Anexar arquivo' })).not.toBeInTheDocument();

    rerender(<Composer onSend={vi.fn()} onAttach={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Anexar arquivo' })).toBeInTheDocument();
  });
});

describe('Composer — emoji (Onda 8 §2.2)', () => {
  it('insere o emoji NA POSIÇÃO DO CURSOR, não no fim do texto', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} />);

    const field = screen.getByLabelText('Mensagem') as HTMLTextAreaElement;
    await user.type(field, 'bom dia tudo bem');
    // cursor logo depois de "bom dia"
    field.setSelectionRange(7, 7);

    await user.click(screen.getByRole('button', { name: 'Inserir emoji' }));
    await user.click(screen.getByRole('button', { name: 'joinha' }));

    expect(field).toHaveValue('bom dia👍 tudo bem');
  });

  it('Esc fecha o popover e devolve o foco ao campo', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Inserir emoji' }));
    expect(screen.getByRole('button', { name: 'joinha' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'joinha' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Mensagem')).toHaveFocus();
  });

  it('conversa arquivada: o botão de emoji fica bloqueado junto com o campo', () => {
    render(<Composer onSend={vi.fn()} disabled />);
    expect(screen.getByRole('button', { name: 'Inserir emoji' })).toBeDisabled();
  });
});

describe('Composer — respostas rápidas (Onda 8 §3.4)', () => {
  const MACROS = [
    {
      id: 'a',
      shortcut: 'coleta',
      title: 'Horário de coleta',
      content: 'Coleta de segunda a sexta, das 6h30 às 11h.',
      createdBy: null,
      createdAt: '2026-09-06T12:00:00.000Z',
      updatedAt: '2026-09-06T12:00:00.000Z',
    },
    {
      id: 'b',
      shortcut: 'jejum',
      title: 'Jejum',
      content: 'Para glicemia, jejum de 8 horas.',
      createdBy: null,
      createdAt: '2026-09-06T12:00:00.000Z',
      updatedAt: '2026-09-06T12:00:00.000Z',
    },
  ];

  it('"/" com o campo VAZIO abre a lista e escolher substitui o texto', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} quickReplies={MACROS} />);

    const field = screen.getByLabelText('Mensagem');
    await user.type(field, '/');

    expect(screen.getByRole('option', { name: /coleta/i })).toBeInTheDocument();

    await user.click(screen.getByRole('option', { name: /jejum/i }));

    expect(field).toHaveValue('Para glicemia, jejum de 8 horas.');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('digitar depois da "/" filtra por atalho', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} quickReplies={MACROS} />);

    await user.type(screen.getByLabelText('Mensagem'), '/jej');

    expect(screen.getByRole('option', { name: /jejum/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /coleta/i })).not.toBeInTheDocument();
  });

  it('"/" NO MEIO do texto não abre nada — "km/h" e "24/48h" continuam digitáveis', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} quickReplies={MACROS} />);

    const field = screen.getByLabelText('Mensagem');
    await user.type(field, 'chega a 24/48h');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(field).toHaveValue('chega a 24/48h');
  });

  it('Enter escolhe o item ativo em vez de enviar a mensagem', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} quickReplies={MACROS} />);

    const field = screen.getByLabelText('Mensagem');
    await user.type(field, '/');
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onSend).not.toHaveBeenCalled();
    expect(field).toHaveValue('Para glicemia, jejum de 8 horas.');
  });

  it('Esc fecha o menu e a "/" continua no campo como texto normal', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} quickReplies={MACROS} />);

    const field = screen.getByLabelText('Mensagem');
    await user.type(field, '/');
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(field).toHaveValue('/');
  });

  it('sem macro que case com o filtro, o menu fecha sozinho', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} quickReplies={MACROS} />);

    await user.type(screen.getByLabelText('Mensagem'), '/zzz');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('sem macros cadastradas, "/" é apenas uma barra', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} quickReplies={[]} />);

    await user.type(screen.getByLabelText('Mensagem'), '/');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

/**
 * CRMLAB-49 — o campo cresce com o texto. O jsdom não faz layout, então as
 * medidas do textarea são simuladas pelo número de linhas: 20px por linha +
 * 14px de padding, 2px de borda (o `border-box` do preflight).
 */
describe('Composer — campo cresce com o texto (CRMLAB-49)', () => {
  const measure = (prop: 'scrollHeight' | 'clientHeight' | 'offsetHeight') =>
    vi.spyOn(HTMLTextAreaElement.prototype, prop, 'get');

  beforeEach(() => {
    measure('clientHeight').mockReturnValue(34);
    measure('offsetHeight').mockReturnValue(36);
    measure('scrollHeight').mockImplementation(function (this: HTMLTextAreaElement) {
      return 14 + 20 * this.value.split('\n').length;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Os getters são HERDADOS (Element/HTMLElement); o restore deixa uma cópia
    // própria embrulhada no protótipo do textarea e o próximo describe que mede
    // o campo estoura a pilha (CRMLAB-51). Apagar a cópia devolve a herança.
    for (const prop of ['scrollHeight', 'clientHeight', 'offsetHeight']) {
      Reflect.deleteProperty(HTMLTextAreaElement.prototype, prop);
    }
  });

  const lines = (n: number) => Array.from({ length: n }, (_, i) => `linha ${i + 1}`).join('\n');

  it('texto curto: uma linha, pílula e sem rolagem', () => {
    render(<Composer onSend={vi.fn()} />);
    const field = screen.getByLabelText('Mensagem');

    expect(field.style.height).toBe('36px');
    expect(field.style.overflowY).toBe('hidden');
    expect(field).toHaveClass('rounded-pill');
  });

  it('quebrou linha: cresce, troca a pílula por radius-md e ainda não rola', () => {
    render(<Composer onSend={vi.fn()} initialValue={lines(3)} />);
    const field = screen.getByLabelText('Mensagem');

    expect(field.style.height).toBe('76px');
    expect(field.style.overflowY).toBe('hidden');
    expect(field).toHaveClass('rounded-md');
    expect(field).not.toHaveClass('rounded-pill');
  });

  it('passou do teto: trava em 150px e rola por dentro', () => {
    render(<Composer onSend={vi.fn()} initialValue={lines(10)} />);
    const field = screen.getByLabelText('Mensagem');

    expect(field.style.height).toBe('150px');
    expect(field.style.overflowY).toBe('auto');
  });

  it('enviar volta o campo para uma linha', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} initialValue={lines(4)} />);
    const field = screen.getByLabelText('Mensagem');
    expect(field.style.height).toBe('96px');

    await user.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(field.style.height).toBe('36px');
    expect(field).toHaveClass('rounded-pill');
  });

  it('Shift+Enter cresce e apagar a quebra diminui de novo', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} />);
    const field = screen.getByLabelText('Mensagem');

    await user.type(field, 'oi');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(field.style.height).toBe('56px');

    await user.keyboard('{Backspace}');
    expect(field.style.height).toBe('36px');
  });

  it('resposta rápida longa recalcula a altura', async () => {
    const user = userEvent.setup();
    const macro = {
      id: 'm',
      shortcut: 'preparo',
      title: 'Preparo',
      content: lines(3),
      createdBy: null,
      createdAt: '2026-09-06T12:00:00.000Z',
      updatedAt: '2026-09-06T12:00:00.000Z',
    };
    render(<Composer onSend={vi.fn()} quickReplies={[macro]} />);
    const field = screen.getByLabelText('Mensagem');

    await user.type(field, '/');
    await user.keyboard('{Enter}');

    expect(field).toHaveValue(lines(3));
    expect(field.style.height).toBe('76px');
  });
});

describe('Composer — Ctrl+B negrito (CRMLAB-51, D-183)', () => {
  it('Ctrl+B envolve a seleção em asteriscos e mantém o texto selecionado', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} />);

    const field = screen.getByLabelText('Mensagem') as HTMLTextAreaElement;
    await user.type(field, 'seu resultado saiu');
    field.setSelectionRange(4, 13); // "resultado"
    await user.keyboard('{Control>}b{/Control}');

    expect(field).toHaveValue('seu *resultado* saiu');
    await waitFor(() => {
      expect(field.selectionStart).toBe(5);
      expect(field.selectionEnd).toBe(14);
    });
  });

  it('Cmd+B (Mac) sem seleção insere ** com o cursor no meio', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} />);

    const field = screen.getByLabelText('Mensagem') as HTMLTextAreaElement;
    await user.type(field, 'olá ');
    await user.keyboard('{Meta>}b{/Meta}');

    expect(field).toHaveValue('olá **');
    await waitFor(() => {
      expect(field.selectionStart).toBe(5);
      expect(field.selectionEnd).toBe(5);
    });
    await user.keyboard('x');
    expect(field).toHaveValue('olá *x*');
  });

  it('espaço nas pontas da seleção fica fora dos asteriscos (senão não formataria)', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} />);

    const field = screen.getByLabelText('Mensagem') as HTMLTextAreaElement;
    await user.type(field, 'seu resultado saiu');
    field.setSelectionRange(3, 14); // " resultado "
    await user.keyboard('{Control>}b{/Control}');

    expect(field).toHaveValue('seu *resultado* saiu');
  });

  it('AltGr+B (Ctrl+Alt no Windows) não vira negrito', async () => {
    const user = userEvent.setup();
    render(<Composer onSend={vi.fn()} />);

    const field = screen.getByLabelText('Mensagem') as HTMLTextAreaElement;
    await user.type(field, 'oi');
    await user.keyboard('{Control>}{Alt>}b{/Alt}{/Control}');

    expect(field.value).not.toContain('*');
  });

  it('o texto vai para onSend com os asteriscos (o WhatsApp formata)', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Composer onSend={onSend} />);

    const field = screen.getByLabelText('Mensagem') as HTMLTextAreaElement;
    await user.type(field, 'urgente');
    field.setSelectionRange(0, 7);
    await user.keyboard('{Control>}b{/Control}{Enter}');

    expect(onSend).toHaveBeenCalledWith('*urgente*');
  });
});
