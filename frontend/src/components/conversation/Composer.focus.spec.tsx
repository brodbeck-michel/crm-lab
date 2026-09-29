import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

/**
 * CRMLAB-63 — depois de enviar, o cursor continua no campo. A causa era o
 * `disabled` do textarea durante o envio: campo desabilitado perde o foco e o
 * navegador não devolve quando reabilita.
 */
describe('Composer — foco depois de enviar (CRMLAB-63)', () => {
  it('Enter: o foco fica no campo durante e depois do envio', async () => {
    const onSend = vi.fn();
    const { rerender } = render(<Composer onSend={onSend} />);
    const field = screen.getByLabelText('Mensagem');

    await userEvent.type(field, 'Bom dia!{Enter}');
    expect(onSend).toHaveBeenCalledWith('Bom dia!');

    // A tela liga `sending` enquanto a requisição voa e desliga quando volta.
    rerender(<Composer onSend={onSend} sending />);
    expect(field).not.toBeDisabled();
    expect(field).toHaveFocus();

    rerender(<Composer onSend={onSend} sending={false} />);
    expect(field).toHaveFocus();
  });

  it('botão Enviar: o foco volta para o campo', async () => {
    const onSend = vi.fn();
    const { rerender } = render(<Composer onSend={onSend} />);
    const field = screen.getByLabelText('Mensagem');

    await userEvent.type(field, 'olá');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(field).toHaveFocus();

    rerender(<Composer onSend={onSend} sending />);
    rerender(<Composer onSend={onSend} sending={false} />);
    expect(field).toHaveFocus();
  });

  it('durante o envio dá para escrever a próxima, mas o Enter não manda de novo', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} sending />);
    const field = screen.getByLabelText('Mensagem');

    await userEvent.type(field, 'segunda{Enter}');

    expect(onSend).not.toHaveBeenCalled();
    expect(field).toHaveValue('segunda');
  });

  it('Shift+Enter continua quebrando linha', async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const field = screen.getByLabelText('Mensagem');

    await userEvent.type(field, 'a{Shift>}{Enter}{/Shift}b');

    expect(onSend).not.toHaveBeenCalled();
    expect(field).toHaveValue('a\nb');
    expect(field).toHaveFocus();
  });

  it('envio com erro: o texto volta para o campo, com o foco', async () => {
    const onSend = vi.fn(() => Promise.reject(new Error('rede')));
    render(<Composer onSend={onSend} />);
    const field = screen.getByLabelText('Mensagem');

    await userEvent.type(field, 'resultado do exame{Enter}');

    expect(await screen.findByDisplayValue('resultado do exame')).toBe(field);
    expect(field).toHaveFocus();
  });

  it('envio com erro NÃO atropela o que a pessoa já começou a escrever', async () => {
    let fail: (reason: Error) => void = () => undefined;
    const onSend = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    render(<Composer onSend={onSend} />);
    const field = screen.getByLabelText('Mensagem');

    await userEvent.type(field, 'primeira{Enter}');
    await userEvent.type(field, 'segunda');
    fail(new Error('rede'));
    await Promise.resolve();

    expect(field).toHaveValue('segunda');
  });

  it('composer desabilitado por outro motivo (arquivada, sem permissão): campo travado', () => {
    render(<Composer onSend={vi.fn()} disabled />);

    const field = screen.getByLabelText('Mensagem');
    expect(field).toBeDisabled();
    expect(field).not.toHaveFocus();
  });
});
