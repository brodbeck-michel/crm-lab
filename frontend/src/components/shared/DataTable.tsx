import { useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/components/ui/cn';
import { EmptyState } from './EmptyState';

export interface DataTableColumn<T> {
  /** Chave estável da coluna. */
  key: string;
  /** Cabeçalho (renderizado 11px caixa alta). */
  header: string;
  /** Célula. Recebe a linha e o índice. */
  render: (row: T, index: number) => ReactNode;
  /**
   * `right` para a última coluna monetária/status — nunca centralizada
   * (regra de tabela do protótipo).
   */
  align?: 'left' | 'right';
  /** Largura mínima da coluna, para que ela não colapse sob o conteúdo. */
  minWidth?: number;
  /**
   * Torna a coluna ordenável pelo cabeçalho (CRMLAB-199). Número: 1º clique do maior para o
   * menor; texto: A–Z. O 2º clique inverte. `null` fica sempre no fim.
   */
  sortValue?: (row: T) => number | string | null;
}

export type DataTableSortDirection = 'asc' | 'desc';

export interface DataTableSort {
  key: string;
  direction: DataTableSortDirection;
}

export interface DataTableProps<T> {
  columns: Array<DataTableColumn<T>>;
  rows: T[];
  /** Id estável por linha (chave do React). */
  rowKey: (row: T, index: number) => string;
  /** Linha clicável — abre detalhe/modal. */
  onRowClick?: (row: T) => void;
  /** Texto do vazio. Padrão "Nenhum registro ainda". */
  emptyMessage?: string;
  /**
   * Largura mínima do conteúdo, em px. O container tem `overflow-x`,
   * então nenhuma coluna colapsa em tela estreita. Padrão 720.
   */
  minWidth?: number;
  /** Ordem inicial (coluna com `sortValue`). Sem ela, as linhas ficam na ordem recebida. */
  defaultSort?: DataTableSort;
  /** Avisa a tela quando a ordem muda (ex.: exportar na ordem da tela). */
  onSortChange?: (sort: DataTableSort) => void;
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

function compareValues(a: number | string | null, b: number | string | null): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/** Ordena uma cópia; `null` sempre no fim, nos dois sentidos; empate mantém a ordem recebida. */
export function sortRows<T>(
  rows: readonly T[],
  sortValue: (row: T) => number | string | null,
  direction: DataTableSortDirection,
): T[] {
  return rows
    .map((row, index) => ({ row, index, value: sortValue(row) }))
    .sort((x, y) => {
      if (x.value === null || y.value === null) {
        if (x.value === y.value) return x.index - y.index;
        return x.value === null ? 1 : -1;
      }
      const diff = compareValues(x.value, y.value);
      if (diff === 0) return x.index - y.index;
      return direction === 'asc' ? diff : -diff;
    })
    .map((entry) => entry.row);
}

/**
 * Tabela do design system.
 * Cartão accent 6% (`neutral-100`) · cabeçalho 11px caixa alta sobre `surface` (12%) ·
 * régua neutral-300 · linhas neutral-200 · hover accent-100 · SEM zebra (D-250).
 * Container com min-width + overflow-x: coluna nunca colapsa.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyMessage = 'Nenhum registro ainda',
  minWidth = 720,
  defaultSort,
  onSortChange,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<DataTableSort | undefined>(defaultSort);
  const sortedRows = useMemo(() => {
    const column = sort ? columns.find((c) => c.key === sort.key) : undefined;
    if (!sort || !column?.sortValue) return rows;
    return sortRows(rows, column.sortValue, sort.direction);
  }, [rows, columns, sort]);

  function toggleSort(column: DataTableColumn<T>) {
    if (!column.sortValue) return;
    let next: DataTableSort;
    if (sort?.key === column.key) {
      next = { key: column.key, direction: sort.direction === 'asc' ? 'desc' : 'asc' };
    } else {
      // 1º clique: texto A–Z, número do maior para o menor (pelo 1º valor não nulo da coluna).
      const sample = rows.map((row) => column.sortValue?.(row) ?? null).find((v) => v !== null);
      next = { key: column.key, direction: typeof sample === 'string' ? 'asc' : 'desc' };
    }
    setSort(next);
    onSortChange?.(next);
  }

  if (rows.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }

  return (
    <div className="w-full overflow-x-auto rounded-lg border border-neutral-200 bg-neutral-100 shadow-sm">
      <table style={{ minWidth }} className="w-full border-collapse font-body text-body text-text">
        <thead>
          <tr className="border-b border-neutral-300 bg-surface">
            {columns.map((column) => {
              const active = sort?.key === column.key && Boolean(column.sortValue);
              const ariaSort = !column.sortValue
                ? undefined
                : active
                  ? sort?.direction === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none';
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={ariaSort}
                  style={column.minWidth ? { minWidth: column.minWidth } : undefined}
                  className={cn(
                    'whitespace-nowrap px-lg py-md font-body text-micro font-semibold uppercase text-neutral-600',
                    column.align === 'right' ? 'text-right' : 'text-left',
                  )}
                >
                  {column.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(column)}
                      className={cn(
                        'inline-flex items-center gap-xs uppercase hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                        active && 'text-text',
                      )}
                    >
                      {column.header}
                      <span aria-hidden="true" className={active ? undefined : 'opacity-40'}>
                        {active ? (sort?.direction === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
              className={cn(
                'border-b border-neutral-200',
                onRowClick && 'cursor-pointer transition-colors hover:bg-accent-100',
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    'px-lg py-md align-middle',
                    column.align === 'right' ? 'text-right' : 'text-left',
                  )}
                >
                  {column.render(row, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
