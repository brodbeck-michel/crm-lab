import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider, useToast } from './Toast';

function Harness() {
  const { toast } = useToast();
  return (
    <>
      <button type="button" onClick={() => toast('Proposta enviada', { tone: 'positive' })}>
        Enviar
      </button>
      <button type="button" onClick={() => toast('Sem conexão', { tone: 'attention' })}>
        Falhar
      </button>
    </>
  );
}

describe('Toast', () => {
  it('useToast fora do provider lança erro claro', () => {
    const Broken = () => {
      useToast();
      return null;
    };
    // O React loga o erro do render mesmo capturado — silencia só aqui.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => render(<Broken />)).toThrow(/ToastProvider/);
    } finally {
      spy.mockRestore();
    }
  });

  it('exibe a mensagem enfileirada', async () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText('Proposta enviada')).toBeInTheDocument();
  });

  it('empilha múltiplos toasts', async () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Falhar' }));
    expect(screen.getAllByRole('status')).toHaveLength(2);
  });

  it('o tom escolhido chega ao DOM', async () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Falhar' }));
    expect(await screen.findByRole('status')).toHaveAttribute('data-tone', 'attention');
  });

  it('fecha pelo botão de fechar', async () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await screen.findByText('Proposta enviada');

    await userEvent.click(screen.getByRole('button', { name: 'Fechar notificação' }));
    await waitFor(() => {
      expect(screen.queryByText('Proposta enviada')).not.toBeInTheDocument();
    });
  });
});
