import type { PaginationMeta } from '@crm-lab/shared';
import { Button } from '@/components/ui';

export interface PaginationProps {
  /** Metadados que TODA listagem devolve (`docs/api/API_CONTRACTS.md` — D-009). */
  pagination: PaginationMeta;
  /** Recebe o número da página desejada (1-based). A tela decide onde guardar. */
  onPageChange: (page: number) => void;
  /**
   * Substantivo contado, já no plural pt-BR: "propostas", "exames".
   * Aparece em "N propostas · página X de Y".
   */
  itemLabel: string;
}

/**
 * Navegação de páginas de uma listagem (`shared/`).
 *
 * Existe porque `/proposals` e `/catalog` carregavam só a primeira página: o
 * backend devolve `pagination`, a tela ignorava, e todo registro fora das
 * primeiras 20 linhas ficava INALCANÇÁVEL pela UI.
 *
 * Não guarda estado e não busca dado: recebe o `pagination` que veio do
 * TanStack Query e devolve a página pedida. Quem guarda a página é a tela
 * (URL ou `useState`) — nunca o Zustand, que é reservado a estado de sessão.
 */
export function Pagination({ pagination, onPageChange, itemLabel }: PaginationProps) {
  const { page, total, totalPages } = pagination;

  // Uma página só (ou nenhuma) não tem o que navegar.
  if (total === 0 || totalPages <= 1) return null;

  const hasPrevious = page > 1;
  const hasNext = page < totalPages;

  return (
    <nav
      aria-label={`Paginação de ${itemLabel}`}
      className="flex flex-wrap items-center justify-between gap-md"
    >
      <span className="font-body text-caption text-neutral-600">
        {total} {itemLabel} · página {page} de {totalPages}
      </span>
      <div className="flex items-center gap-sm">
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasPrevious}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          Anterior
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasNext}
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        >
          Próxima
        </Button>
      </div>
    </nav>
  );
}
