import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { defaultPeriod, isPeriodInvalid, PeriodFilter, previousPeriod } from './PeriodFilter';

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

  it('o atalho correspondente ao período em vigor fica marcado', () => {
    render(<PeriodFilter value={defaultPeriod()} onChange={vi.fn()} />);

    // defaultPeriod() são os últimos 30 dias — é esse atalho que aparece ligado.
    expect(screen.getByRole('button', { name: '30 dias' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Hoje' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('período livre não marca nenhum atalho', () => {
    render(
      <PeriodFilter value={{ startDate: '2026-01-03', endDate: '2026-02-11' }} onChange={vi.fn()} />,
    );

    for (const label of ['Hoje', '7 dias', '30 dias', 'Mês atual']) {
      expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('previousPeriod() devolve o período imediatamente anterior, de mesma duração', () => {
    expect(previousPeriod({ startDate: '2026-09-01', endDate: '2026-09-30' })).toEqual({
      startDate: '2026-08-02',
      endDate: '2026-08-31',
    });
  });

  it('previousPeriod() de um único dia continua um único dia', () => {
    expect(previousPeriod({ startDate: '2026-09-15', endDate: '2026-09-15' })).toEqual({
      startDate: '2026-09-14',
      endDate: '2026-09-14',
    });
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

  // CRMLAB-132: o input de data entrega '' enquanto a pessoa apaga/digita, e
  // `toISOString()` de data inválida derrubava `/results` inteira.
  it('previousPeriod() com data vazia ou incompleta não lança e devolve o período como veio', () => {
    for (const period of [
      { startDate: '', endDate: '2026-09-30' },
      { startDate: '2026-09-01', endDate: '' },
      { startDate: '202-09-01', endDate: '2026-09-30' },
    ]) {
      expect(() => previousPeriod(period)).not.toThrow();
      expect(previousPeriod(period)).toEqual(period);
    }
  });

  it('isPeriodInvalid() pega data vazia, incompleta e final antes da inicial', () => {
    expect(isPeriodInvalid({ startDate: '2026-09-01', endDate: '2026-09-30' })).toBe(false);
    expect(isPeriodInvalid({ startDate: '', endDate: '2026-09-30' })).toBe(true);
    expect(isPeriodInvalid({ startDate: '2026-09-01', endDate: '' })).toBe(true);
    expect(isPeriodInvalid({ startDate: '2026-13-45', endDate: '2026-09-30' })).toBe(true);
    expect(isPeriodInvalid({ startDate: '2026-09-10', endDate: '2026-09-01' })).toBe(true);
  });

  it('data vazia pede as duas datas, sem round-trip ao servidor', () => {
    render(<PeriodFilter value={{ startDate: '', endDate: '2026-09-01' }} onChange={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Informe as duas datas.');
  });
});
