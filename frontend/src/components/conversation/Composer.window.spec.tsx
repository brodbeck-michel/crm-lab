import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WhatsAppWindowStatus } from '@crm-lab/shared';
import { Composer } from './Composer';

/** Composer — janela de 24 h da Cloud API (CRMLAB-137, D-310). */
const OPEN: WhatsAppWindowStatus = {
  open: true,
  remainingSeconds: 3 * 3600 + 12 * 60,
  expiresAt: '2026-11-05T12:00:00.000Z',
  lastPatientMessageAt: '2026-11-04T12:00:00.000Z',
};
const CLOSED: WhatsAppWindowStatus = {
  open: false,
  remainingSeconds: 0,
  expiresAt: null,
  lastPatientMessageAt: null,
};

afterEach(() => vi.useRealTimers());

describe('Composer — janela de 24 h', () => {
  it('sem whatsappWindow (QR): nenhum aviso e envio livre', () => {
    render(<Composer onSend={vi.fn()} />);
    expect(screen.queryByTestId('window-banner')).toBeNull();
    expect(screen.getByLabelText('Mensagem')).toBeEnabled();
  });

  it('aberta: mostra o tempo restante e não bloqueia', () => {
    render(<Composer onSend={vi.fn()} whatsappWindow={OPEN} />);
    expect(screen.getByTestId('window-remaining')).toHaveTextContent('3 h 12 min');
    expect(screen.queryByTestId('window-template-button')).toBeNull();
    expect(screen.getByLabelText('Mensagem')).toBeEnabled();
  });

  it('fechada: mostra o motivo, bloqueia o envio e deixa o template como "em breve"', () => {
    render(<Composer onSend={vi.fn()} onPickFiles={vi.fn()} whatsappWindow={CLOSED} />);
    expect(screen.getByRole('alert')).toHaveTextContent('janela de 24 horas do WhatsApp está fechada');
    expect(screen.getByTestId('window-remaining')).toHaveTextContent('encerrada');
    expect(screen.getByLabelText('Mensagem')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Anexar arquivo' })).toBeDisabled();
    const template = screen.getByTestId('window-template-button');
    expect(template).toBeDisabled();
    expect(template).toHaveTextContent('disponível em breve');
  });

  it('a janela fecha sozinha quando o tempo que o servidor deu acaba', () => {
    vi.useFakeTimers();
    render(
      <Composer onSend={vi.fn()} whatsappWindow={{ ...OPEN, remainingSeconds: 40 }} />,
    );
    expect(screen.getByLabelText('Mensagem')).toBeEnabled();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByLabelText('Mensagem')).toBeDisabled();
    expect(screen.getByTestId('window-template-button')).toBeDisabled();
  });
});
