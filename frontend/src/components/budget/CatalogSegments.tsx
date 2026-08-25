import { useState } from 'react';
import { useExamListInfinite } from '@/api/exams';
import { Button, SearchInput, SegmentedControl } from '@/components/ui';
import { MoneyDisplay } from '@/components/shared/MoneyDisplay';

/** Mesmo default do backend (`docs/api/API_CONTRACTS.md` §4). */
const PAGE_SIZE = 20;

interface CatalogSegmentsProps {
  onAddItem: (examId: string, examName: string, price: number) => void;
}

/**
 * Coluna esquerda de `/budget/new` (PAGES.md §4).
 *
 * ALCANCE DO CATÁLOGO (D-080) — por que aqui NÃO tem `Pagination`
 * -------------------------------------------------------------
 * Esta coluna é um SELETOR, não uma tabela: o usuário está montando um
 * carrinho na coluna da direita enquanto procura na esquerda. Trocar a página
 * sob ele (como `/proposals` e `/catalog` fazem, e fazem certo) tiraria da
 * tela o que ele acabou de ver e não devolveria nada em troca — não há
 * "linha 47" que se queira revisitar num seletor.
 *
 * O que existe é: busca server-side (recorta o catálogo INTEIRO no banco, não
 * as linhas já carregadas) + carga incremental ("Carregar mais"), que acumula
 * páginas. Assim todo exame ativo é alcançável, com quantos exames o
 * laboratório tiver.
 */
export default function CatalogSegments({ onAddItem }: CatalogSegmentsProps) {
  const [search, setSearch] = useState('');
  const [segment, setSegment] = useState<'catalog' | 'medical' | 'ai' | 'packages'>('catalog');
  const [pricingMode, setPricingMode] = useState<'private' | 'insurance'>('private');

  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useExamListInfinite({
    active: true,
    search: search || undefined,
    limit: PAGE_SIZE,
  });

  /** Todas as páginas já trazidas, na ordem em que vieram (`name ASC`). */
  const exams = data?.pages.flatMap((page) => page.exams) ?? [];
  const total = data?.pages[0]?.pagination.total ?? 0;

  const handleAddExam = (examId: string, examName: string) => {
    const exam = exams.find((e) => e.id === examId);
    if (exam) {
      const price =
        pricingMode === 'private' ? exam.pricePrivate : exam.priceInsurance;
      onAddItem(examId, examName, price);
    }
  };

  return (
    <div className="flex flex-col gap-lg p-lg h-full">
      <h2 className="font-heading text-section">Catálogo</h2>

      <SegmentedControl
        options={[
          { label: 'Catálogo', value: 'catalog' },
          { label: 'Pedido Médico', value: 'medical' },
          { label: 'IA', value: 'ai' },
          { label: 'Pacotes', value: 'packages' },
        ]}
        value={segment}
        onChange={(val) => setSegment(val as 'catalog' | 'medical' | 'ai' | 'packages')}
      />

      <SegmentedControl
        options={[
          { label: 'Particular', value: 'private' },
          { label: 'Convênio', value: 'insurance' },
        ]}
        value={pricingMode}
        onChange={(val) => setPricingMode(val as 'private' | 'insurance')}
      />

      <SearchInput
        placeholder="Buscar exame..."
        onSearch={setSearch}
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-xl text-neutral-600">
          Carregando...
        </div>
      ) : exams.length === 0 ? (
        <div className="flex items-center justify-center py-xl text-neutral-600">
          Nenhum exame encontrado
        </div>
      ) : (
        <div className="space-y-sm overflow-y-auto flex-1">
          {exams.map((exam) => (
            <button
              key={exam.id}
              onClick={() => handleAddExam(exam.id, exam.name)}
              className="w-full flex justify-between items-center p-md hover:bg-neutral-100 rounded-md transition-colors text-left"
            >
              <div className="flex-1 min-w-0">
                <p className="text-label font-semibold truncate">{exam.name}</p>
                {exam.code && (
                  <p className="text-caption text-neutral-600">{exam.code}</p>
                )}
              </div>
              <MoneyDisplay
                value={
                  pricingMode === 'private'
                    ? exam.pricePrivate
                    : exam.priceInsurance
                }
              />
            </button>
          ))}

          {/*
            O rodapé só existe quando ainda há catálogo fora da tela. Ele diz
            QUANTO falta: sem o contador, "Carregar mais" não distingue "faltam
            3" de "faltam 300", e o usuário não sabe se vale buscar em vez de
            rolar.
          */}
          {hasNextPage && (
            <div className="flex flex-col items-center gap-sm pt-md">
              <span className="font-body text-caption text-neutral-600">
                {exams.length} de {total} exames
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={isFetchingNextPage}
                onClick={() => {
                  void fetchNextPage();
                }}
              >
                {isFetchingNextPage ? 'Carregando...' : 'Carregar mais'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
