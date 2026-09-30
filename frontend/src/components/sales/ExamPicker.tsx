import { useId, useMemo, useState } from 'react';
import type { Exam } from '@crm-lab/shared';
import { useExamListInfinite } from '@/api/exams';
import { SearchInput, cn } from '@/components/ui';

export interface PickedExam {
  id: string;
  name: string;
}

export interface ExamPickerProps {
  label?: string;
  value: PickedExam[];
  onChange: (next: PickedExam[]) => void;
  error?: string;
}

const NO_CATEGORY = 'Sem categoria';

/**
 * Seletor de exames do catálogo para a venda avulsa (D-247, PAGES.md §17).
 * Busca server-side por nome/sinônimo/código; agrupa por categoria; os
 * escolhidos ficam como chips removíveis abaixo do gatilho. O painel abre
 * embaixo do gatilho (não flutua), para não ser cortado pelo scroll do modal.
 */
export function ExamPicker({ label = 'Exames', value, onChange, error }: ExamPickerProps) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useExamListInfinite({
    active: true,
    search: search || undefined,
    sortBy: 'category',
    limit: 100,
  });

  const groups = useMemo(() => {
    const exams = data?.pages.flatMap((page) => page.exams) ?? [];
    const byCategory = new Map<string, Exam[]>();
    for (const exam of exams) {
      const key = exam.category?.trim() || NO_CATEGORY;
      byCategory.set(key, [...(byCategory.get(key) ?? []), exam]);
    }
    return [...byCategory.entries()]
      .sort(([a], [b]) =>
        a === NO_CATEGORY ? 1 : b === NO_CATEGORY ? -1 : a.localeCompare(b, 'pt-BR'),
      )
      .map(([category, items]) => ({
        category,
        items: [...items].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
      }));
  }, [data]);

  const selectedIds = new Set(value.map((exam) => exam.id));

  const toggle = (exam: Exam) => {
    onChange(
      selectedIds.has(exam.id)
        ? value.filter((picked) => picked.id !== exam.id)
        : [...value, { id: exam.id, name: exam.name }],
    );
  };

  const remove = (id: string) => onChange(value.filter((picked) => picked.id !== id));

  return (
    <div className="flex w-full flex-col gap-xs">
      <span className="font-body text-caption font-semibold text-neutral-700">{label}</span>

      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'flex w-full items-center justify-between gap-sm rounded-pill border bg-bg px-lg py-[10px]',
          'text-left font-body text-label transition-colors focus:border-accent focus:outline-none',
          error ? 'border-accent-600' : 'border-neutral-300',
        )}
      >
        <span className={value.length === 0 ? 'text-neutral-600' : 'text-text'}>
          {value.length === 0 ? 'Selecione exames…' : `${value.length} exame(s) selecionado(s)`}
        </span>
        <span aria-hidden="true" className="text-neutral-600">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <div id={panelId} className="flex flex-col gap-xs rounded-md border border-neutral-300 p-sm">
          <SearchInput
            placeholder="Buscar exame por nome, sinônimo ou código..."
            aria-label="Buscar exame"
            onSearch={setSearch}
          />
          <div role="listbox" aria-multiselectable="true" className="max-h-[280px] overflow-y-auto">
            {isLoading ? (
              <span className="block p-sm text-body text-neutral-600">Carregando...</span>
            ) : groups.length === 0 ? (
              <span className="block p-sm text-body text-neutral-600">Nenhum exame encontrado</span>
            ) : (
              groups.map((group) => (
                <div key={group.category} role="group" aria-label={group.category}>
                  <div className="px-sm pb-xs pt-sm font-body text-caption font-semibold text-neutral-600">
                    {group.category}
                  </div>
                  {group.items.map((exam) => {
                    const selected = selectedIds.has(exam.id);
                    return (
                      <button
                        key={exam.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => toggle(exam)}
                        className={cn(
                          'flex w-full items-center gap-sm rounded-md px-sm py-xs text-left',
                          selected ? 'bg-accent2-200 text-accent2-800' : 'hover:bg-neutral-100',
                        )}
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-body text-body">{exam.name}</span>
                          {exam.synonyms.length > 0 && (
                            <span className="truncate font-body text-caption text-neutral-600">
                              {exam.synonyms.join(', ')}
                            </span>
                          )}
                        </span>
                        <span className="flex-[0_0_auto] font-body text-caption text-neutral-600">
                          {exam.code}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
            {hasNextPage && (
              <button
                type="button"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className="w-full p-sm font-body text-caption font-semibold text-accent-700"
              >
                {isFetchingNextPage ? 'Carregando...' : 'Carregar mais exames'}
              </button>
            )}
          </div>
        </div>
      )}

      {value.length > 0 && (
        <ul className="flex flex-wrap gap-xs" aria-label="Exames selecionados">
          {value.map((exam) => (
            <li
              key={exam.id}
              className="inline-flex items-center gap-xs rounded-pill bg-accent2-200 px-[11px] py-[3px] font-body text-caption font-semibold text-accent2-800"
            >
              {exam.name}
              <button
                type="button"
                aria-label={`Remover ${exam.name}`}
                onClick={() => remove(exam.id)}
                className="text-accent2-800 hover:text-text"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <span role="alert" className="font-body text-caption text-accent-700">
          {error}
        </span>
      )}
    </div>
  );
}
