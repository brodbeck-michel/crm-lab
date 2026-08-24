import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable } from './DataTable';
import type { DataTableColumn } from './DataTable';
import { MoneyDisplay } from './MoneyDisplay';

interface Row {
  id: string;
  exam: string;
  price: number;
}

const rows: Row[] = [
  { id: '1', exam: 'Hemograma', price: 32 },
  { id: '2', exam: 'TSH', price: 48.5 },
];

const columns: Array<DataTableColumn<Row>> = [
  { key: 'exam', header: 'Exame', render: (row) => row.exam },
  {
    key: 'price',
    header: 'Valor',
    align: 'right',
    render: (row) => <MoneyDisplay value={row.price} />,
  },
];

describe('DataTable', () => {
  it('renderiza cabeçalhos e linhas', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} />);
    expect(screen.getByRole('columnheader', { name: 'Exame' })).toBeInTheDocument();
    expect(screen.getByText('Hemograma')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3); // 1 cabeçalho + 2 linhas
  });

  it('cabeçalho é 11px caixa alta com régua neutral-300', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} />);
    const header = screen.getByRole('columnheader', { name: 'Exame' });
    expect(header).toHaveClass('text-micro');
    expect(header).toHaveClass('uppercase');
    expect(header.parentElement).toHaveClass('border-neutral-300');
  });

  it('a última coluna monetária alinha à direita', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} />);
    expect(screen.getByRole('columnheader', { name: 'Valor' })).toHaveClass('text-right');
  });

  it('mostra EmptyState quando não há linhas', () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        emptyMessage="Nenhum exame ainda"
      />,
    );
    expect(screen.getByText('Nenhum exame ainda')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('linha clicável dispara onRowClick por clique e por Enter', async () => {
    const onRowClick = vi.fn();
    render(
      <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} onRowClick={onRowClick} />,
    );

    const [, firstRow] = screen.getAllByRole('row');
    expect(firstRow).toBeDefined();
    if (!firstRow) return;

    await userEvent.click(firstRow);
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);

    firstRow.focus();
    await userEvent.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });

  it('container tem overflow-x e a tabela um min-width — coluna nunca colapsa', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(row) => row.id} minWidth={900} />);
    const table = screen.getByRole('table');
    expect(table).toHaveStyle({ minWidth: '900px' });
    expect(table.parentElement).toHaveClass('overflow-x-auto');
  });
});
