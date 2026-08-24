import type { ReactNode } from 'react';
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
}

/**
 * Tabela do design system.
 * Cabeçalho 11px caixa alta · régua neutral-300 · linhas neutral-200 · SEM zebra.
 * Container com min-width + overflow-x: coluna nunca colapsa.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyMessage = 'Nenhum registro ainda',
  minWidth = 720,
}: DataTableProps<T>) {
  if (rows.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }

  return (
    <div className="w-full overflow-x-auto rounded-lg bg-neutral-100 shadow-sm">
      <table
        style={{ minWidth }}
        className="w-full border-collapse font-body text-body text-text"
      >
        <thead>
          <tr className="border-b border-neutral-300">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.minWidth ? { minWidth: column.minWidth } : undefined}
                className={cn(
                  'whitespace-nowrap px-lg py-md font-body text-micro font-semibold uppercase text-neutral-600',
                  column.align === 'right' ? 'text-right' : 'text-left',
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
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
