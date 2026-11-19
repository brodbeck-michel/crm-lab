import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PasswordInput } from './PasswordInput';

describe('PasswordInput (CRMLAB-185)', () => {
  it('começa oculto e o olho alterna mostrar/ocultar', async () => {
    render(<PasswordInput label="Senha" defaultValue="segredo" />);
    const field = screen.getByLabelText('Senha');
    expect(field).toHaveAttribute('type', 'password');

    await userEvent.click(screen.getByRole('button', { name: 'Mostrar senha' }));
    expect(field).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Ocultar senha' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Ocultar senha' }));
    expect(field).toHaveAttribute('type', 'password');
  });

  it('o olho não envia o formulário', async () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordInput label="Senha" />
      </form>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Mostrar senha' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('avisa Caps Lock ligado e some ao desligar ou sair do campo', async () => {
    const user = userEvent.setup();
    render(<PasswordInput label="Senha" />);
    const field = screen.getByLabelText('Senha');

    await user.click(field);
    await user.keyboard('{CapsLock}');
    expect(screen.getByRole('status')).toHaveTextContent('Caps Lock está ligado');

    // Desligou: o user-event só reflete o estado novo no evento seguinte (no navegador vem
    // já no keydown/keyup do próprio Caps Lock) — a próxima tecla limpa o aviso.
    await user.keyboard('{CapsLock}a');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await user.keyboard('{CapsLock}');
    expect(screen.getByRole('status')).toBeInTheDocument();
    await user.tab();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('repassa onKeyDown e onBlur do chamador', async () => {
    const onKeyDown = vi.fn();
    const onBlur = vi.fn();
    render(<PasswordInput label="Senha" onKeyDown={onKeyDown} onBlur={onBlur} />);
    await userEvent.type(screen.getByLabelText('Senha'), 'a');
    await userEvent.tab();
    expect(onKeyDown).toHaveBeenCalled();
    expect(onBlur).toHaveBeenCalled();
  });
});
