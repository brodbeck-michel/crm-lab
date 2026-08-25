import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PaginationMeta } from '@crm-lab/shared';
import { Pagination } from './Pagination';

function meta(overrides: Partial<PaginationMeta> = {}): PaginationMeta {
  return { page: 2, limit: 20, total: 45, totalPages: 3, ...overrides };
}

describe('Pagination', () => {
  it('mostra o total e a posição atual', () => {
    render(<Pagination pagination={meta()} onPageChange={vi.fn()} itemLabel="propostas" />);

    expect(screen.getByText('45 propostas · página 2 de 3')).toBeInTheDocument();
  });

  it('avança e volta uma página', async () => {
    const user = userEvent.setup({ delay: null });
    const onPageChange = vi.fn();

    render(<Pagination pagination={meta()} onPageChange={onPageChange} itemLabel="exames" />);

    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(onPageChange).toHaveBeenCalledWith(3);

    await user.click(screen.getByRole('button', { name: 'Anterior' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('desabilita "Anterior" na primeira página', () => {
    render(
      <Pagination pagination={meta({ page: 1 })} onPageChange={vi.fn()} itemLabel="exames" />,
    );

    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Próxima' })).toBeEnabled();
  });

  it('desabilita "Próxima" na última página', () => {
    render(
      <Pagination pagination={meta({ page: 3 })} onPageChange={vi.fn()} itemLabel="exames" />,
    );

    expect(screen.getByRole('button', { name: 'Próxima' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeEnabled();
  });

  it('não renderiza quando há uma página só', () => {
    const { container } = render(
      <Pagination
        pagination={meta({ page: 1, total: 3, totalPages: 1 })}
        onPageChange={vi.fn()}
        itemLabel="exames"
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('não renderiza quando a listagem está vazia', () => {
    const { container } = render(
      <Pagination
        pagination={meta({ page: 1, total: 0, totalPages: 0 })}
        onPageChange={vi.fn()}
        itemLabel="exames"
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
