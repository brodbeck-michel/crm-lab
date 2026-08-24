import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
