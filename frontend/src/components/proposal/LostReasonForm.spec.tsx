import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import LostReasonForm from './LostReasonForm';

describe('LostReasonForm — regra "Exigir motivo" (CRMLAB-56, D-192)', () => {
  it('motivo exigido (padrão): Confirmar só com motivo', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<LostReasonForm onSubmit={onSubmit} />);

    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Motivo da Perda'), 'preco');
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(onSubmit).toHaveBeenCalledWith('preco');
  });

  it('motivo não exigido: confirma sem motivo', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<LostReasonForm onSubmit={onSubmit} requireReason={false} />);

    expect(screen.getByLabelText('Motivo da Perda (opcional)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(onSubmit).toHaveBeenCalledWith(undefined);
  });

  it('oferece "Horário de atendimento" antes de "Outro" (CRMLAB-98, D-268)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<LostReasonForm onSubmit={onSubmit} />);

    const select = screen.getByLabelText('Motivo da Perda');
    const labels = Array.from(select.querySelectorAll('option'))
      .map((o) => o.textContent)
      .filter((t) => t !== '' && t !== null);
    expect(labels.slice(-2)).toEqual(['Horário de atendimento', 'Outro']);

    await user.selectOptions(select, 'horario_atendimento');
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(onSubmit).toHaveBeenCalledWith('horario_atendimento');
  });
});
