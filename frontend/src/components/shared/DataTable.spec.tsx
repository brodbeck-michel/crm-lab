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

describe('DataTable — ordenação por coluna (CRMLAB-199)', () => {
  interface Doc {
    id: string;
    name: string | null;
    value: number;
  }
  const docs: Doc[] = [
    { id: '1', name: 'Beatriz', value: 50 },
    { id: '2', name: 'álvaro', value: 300 },
    { id: '3', name: null, value: 10 },
    { id: '4', name: 'Carla', value: 120 },
  ];
  const sortable: Array<DataTableColumn<Doc>> = [
    { key: 'name', header: 'Médico', sortValue: (r) => r.name, render: (r) => r.name ?? 'Sem médico' },
    { key: 'value', header: 'Recebido', align: 'right', sortValue: (r) => r.value, render: (r) => String(r.value) },
    { key: 'id', header: 'Id', render: (r) => r.id },
  ];
  const firstColumn = () =>
    screen.getAllByRole('row').slice(1).map((row) => row.querySelector('td')?.textContent);

  it('número: 1º clique do maior para o menor, 2º inverte; aria-sort acompanha', async () => {
    render(<DataTable columns={sortable} rows={docs} rowKey={(r) => r.id} />);
    const header = screen.getByRole('columnheader', { name: /Recebido/ });
    expect(header).toHaveAttribute('aria-sort', 'none');

    await userEvent.click(screen.getByRole('button', { name: /Recebido/ }));
    expect(firstColumn()).toEqual(['álvaro', 'Carla', 'Beatriz', 'Sem médico']);
    expect(header).toHaveAttribute('aria-sort', 'descending');

    await userEvent.click(screen.getByRole('button', { name: /Recebido/ }));
    expect(firstColumn()).toEqual(['Sem médico', 'Beatriz', 'Carla', 'álvaro']);
    expect(header).toHaveAttribute('aria-sort', 'ascending');
  });

  it('texto: 1º clique A–Z sem caixa/acento, nulo sempre no fim, 2º inverte', async () => {
    render(<DataTable columns={sortable} rows={docs} rowKey={(r) => r.id} />);
    await userEvent.click(screen.getByRole('button', { name: /Médico/ }));
    expect(firstColumn()).toEqual(['álvaro', 'Beatriz', 'Carla', 'Sem médico']);
    await userEvent.click(screen.getByRole('button', { name: /Médico/ }));
    expect(firstColumn()).toEqual(['Carla', 'Beatriz', 'álvaro', 'Sem médico']);
  });

  it('defaultSort abre ordenado; coluna sem sortValue não vira botão', () => {
    render(
      <DataTable
        columns={sortable}
        rows={docs}
        rowKey={(r) => r.id}
        defaultSort={{ key: 'value', direction: 'desc' }}
      />,
    );
    expect(firstColumn()).toEqual(['álvaro', 'Carla', 'Beatriz', 'Sem médico']);
    expect(screen.queryByRole('button', { name: /^Id/ })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Id' })).not.toHaveAttribute('aria-sort');
  });

  it('sem nenhuma coluna ordenável, mantém a ordem recebida', () => {
    const plain = sortable.map(({ sortValue: _ignored, ...rest }) => rest);
    render(<DataTable columns={plain} rows={docs} rowKey={(r) => r.id} />);
    expect(firstColumn()).toEqual(['Beatriz', 'álvaro', 'Sem médico', 'Carla']);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
