import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Chip } from './Chip';

describe('Chip', () => {
  it('tom positive usa a rampa do accent-2', () => {
    render(<Chip tone="positive">Ganho</Chip>);
    const chip = screen.getByText('Ganho');
    expect(chip).toHaveClass('bg-accent2-200');
    expect(chip).toHaveClass('text-accent2-800');
  });

  it('tom attention usa a rampa do accent', () => {
    render(<Chip tone="attention">Aguardando</Chip>);
    const chip = screen.getByText('Aguardando');
    expect(chip).toHaveClass('bg-accent-200');
    expect(chip).toHaveClass('text-accent-800');
  });

  it('tom inactive usa neutral-200', () => {
    render(<Chip tone="inactive">Convênio</Chip>);
    expect(screen.getByText('Convênio')).toHaveClass('bg-neutral-200');
  });

  it('sem onClick não é interativo', () => {
    render(<Chip tone="positive">Ganho</Chip>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('com onClick vira botão e dispara ao clicar', async () => {
    const onClick = vi.fn();
    render(
      <Chip tone="inactive" onClick={onClick}>
        Não atribuídas
      </Chip>,
    );
    const chip = screen.getByRole('button', { name: 'Não atribuídas' });
    await userEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('expõe o estado selecionado via aria-pressed', () => {
    render(
      <Chip tone="inactive" selected onClick={() => {}}>
        Filtro
      </Chip>,
    );
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });

  it('não dispara quando disabled', async () => {
    const onClick = vi.fn();
    render(
      <Chip tone="inactive" disabled onClick={onClick}>
        Filtro
      </Chip>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});
