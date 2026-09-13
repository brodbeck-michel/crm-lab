import { useState } from 'react';
import { useExamListInfinite } from '@/api/exams';
import { useExamPackageList } from '@/api/exam-packages';
import { Button, SearchInput, SegmentedControl } from '@/components/ui';
import { MoneyDisplay } from '@/components/shared/MoneyDisplay';
import type { ExamPackage } from '@crm-lab/shared';
import InsuranceSelector from './InsuranceSelector';

/** Mesmo default do backend (`docs/api/API_CONTRACTS.md` §4). */
const PAGE_SIZE = 20;

interface CatalogSegmentsProps {
  /** Convênio da proposta em montagem (Onda 7, D-082). `null` = particular. */
  insuranceId: string | null;
  onInsuranceChange: (insuranceId: string | null) => void;
  onAddItem: (
    examId: string,
    examName: string,
    price: number,
    priceSource: 'insurance' | 'private'
  ) => void;
  /** CRMLAB-10 — expande o pacote em N linhas no resumo (`BudgetNew.handleAddPackage`). */
  onAddPackage: (pkg: ExamPackage) => void;
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
export default function CatalogSegments({
  insuranceId,
  onInsuranceChange,
  onAddItem,
  onAddPackage,
}: CatalogSegmentsProps) {
  const [search, setSearch] = useState('');
  const [segment, setSegment] = useState<'catalog' | 'medical' | 'ai' | 'packages'>('catalog');

  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useExamListInfinite({
    active: true,
    search: search || undefined,
    limit: PAGE_SIZE,
    insuranceId: insuranceId ?? undefined,
  });

  /**
   * CRMLAB-10 — segmento "Pacotes". Sem paginação (mesmo espírito do catálogo
   * aqui: é um seletor, D-080) — carrega até 100 pacotes ativos, teto do
   * contrato (§4b). `insuranceId` traz `effectivePrice`/`priceSource` do
   * PACOTE (prévia no seletor); a expansão em linhas usa o preço particular de
   * cada exame incluído (SCHEMA.md §30) — `onAddPackage` decide isso.
   */
  const { data: packagesData, isLoading: packagesLoading } = useExamPackageList({
    active: true,
    search: segment === 'packages' ? search || undefined : undefined,
    limit: 100,
    insuranceId: insuranceId ?? undefined,
  });
  const packages = packagesData?.packages ?? [];

  /** Todas as páginas já trazidas, na ordem em que vieram (`name ASC`). */
  const exams = data?.pages.flatMap((page) => page.exams) ?? [];
  const total = data?.pages[0]?.pagination.total ?? 0;

  /**
   * Sem convênio selecionado o preço é sempre o particular. Com convênio, o
   * backend já devolve `effectivePrice`/`priceSource` — com fallback para o
   * particular quando o exame não tem preço próprio na tabela do convênio
   * (D-004, "fallback nunca bloqueia"). `unitPrice` aqui é só a prévia na
   * tela: o backend recalcula os dois em `POST /proposals`.
   */
  const handleAddExam = (examId: string, examName: string) => {
    const exam = exams.find((e) => e.id === examId);
    if (!exam) return;

    if (!insuranceId) {
      onAddItem(examId, examName, exam.pricePrivate, 'private');
      return;
    }

    const price = exam.effectivePrice ?? exam.pricePrivate;
    const priceSource = exam.priceSource ?? 'private';
    onAddItem(examId, examName, price, priceSource);
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

      <InsuranceSelector value={insuranceId} onChange={onInsuranceChange} />

      {(segment === 'catalog' || segment === 'packages') && (
        <SearchInput
          key={segment}
          placeholder={segment === 'catalog' ? 'Buscar exame...' : 'Buscar pacote...'}
          onSearch={setSearch}
        />
      )}

      {segment === 'medical' || segment === 'ai' ? (
        <div className="flex items-center justify-center py-xl text-neutral-600 text-center">
          {segment === 'medical' ? 'Pedido Médico' : 'IA'} ainda não disponível nesta tela
          (CRMLAB-13).
        </div>
      ) : segment === 'packages' ? (
        packagesLoading ? (
          <div className="flex items-center justify-center py-xl text-neutral-600">
            Carregando...
          </div>
        ) : packages.length === 0 ? (
          <div className="flex items-center justify-center py-xl text-neutral-600">
            Nenhum pacote encontrado
          </div>
        ) : (
          <div className="space-y-sm overflow-y-auto flex-1">
            {packages.map((pkg) => (
              <button
                key={pkg.id}
                onClick={() => onAddPackage(pkg)}
                className="w-full flex justify-between items-center p-md hover:bg-neutral-100 rounded-md transition-colors text-left"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-label font-semibold truncate">{pkg.name}</p>
                  <p className="text-caption text-neutral-600">
                    {pkg.items.length} exame(s)
                  </p>
                </div>
                <MoneyDisplay value={pkg.effectivePrice ?? pkg.pricePrivate} />
              </button>
            ))}
          </div>
        )
      ) : isLoading ? (
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
              <MoneyDisplay value={exam.effectivePrice ?? exam.pricePrivate} />
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
