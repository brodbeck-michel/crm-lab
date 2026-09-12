import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { defaultPeriod, PeriodFilter } from './PeriodFilter';

describe('PeriodFilter', () => {
  it('defaultPeriod() cobre os últimos 30 dias terminando hoje', () => {
    const period = defaultPeriod();
    const today = new Date().toISOString().slice(0, 10);

    expect(period.endDate).toBe(today);
    const diffDays =
      (new Date(period.endDate).getTime() - new Date(period.startDate).getTime()) / 86_400_000;
    expect(diffDays).toBe(29);
  });

  it('um atalho chama onChange com o período correspondente', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PeriodFilter value={defaultPeriod()} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Hoje' }));

    const today = new Date().toISOString().slice(0, 10);
    expect(onChange).toHaveBeenCalledWith({ startDate: today, endDate: today });
  });

  it('endDate < startDate mostra mensagem inline, sem round-trip ao servidor', () => {
    render(
      <PeriodFilter
        value={{ startDate: '2026-09-10', endDate: '2026-09-01' }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Data final anterior à inicial.');
  });
});
