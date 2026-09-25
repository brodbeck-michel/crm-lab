import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useExamList } from '@/api/exams';
import { useExamPackageList } from '@/api/exam-packages';
import { useAuthStore } from '@/stores/auth.store';
import ExamTable from '@/components/catalog/ExamTable';
import ExamModal from '@/components/catalog/ExamModal';
import ExamImportModal from '@/components/catalog/ExamImportModal';
import PackageTable from '@/components/catalog/PackageTable';
import PackageModal from '@/components/catalog/PackageModal';
import { Button, SearchInput, SegmentedControl } from '@/components/ui';
import { Pagination } from '@/components/shared';
import type { Exam, ExamPackage, ListExamsQuery } from '@crm-lab/shared';

/** Mesmo default do backend (`docs/api/API_CONTRACTS.md` §4/§4b). */
const PAGE_SIZE = 20;

type CatalogTab = 'exams' | 'packages';

export default function Catalog() {
  const user = useAuthStore((s) => s.user);
  const [tab, setTab] = useState<CatalogTab>('exams');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editExam, setEditExam] = useState<Exam | undefined>();
  const [editPackage, setEditPackage] = useState<ExamPackage | undefined>();

  /** Página na URL (`?page=2`), pelo mesmo motivo de `/proposals`. Compartilhada
   * pelas duas abas — trocar de aba também reinicia a página (mesma regra de
   * "buscar reinicia a página"), já que os conjuntos são diferentes. */
  const [searchParams, setSearchParams] = useSearchParams();
  const parsedPage = Number.parseInt(searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;

  const goToPage = (next: number) => {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next <= 1) params.delete('page');
        else params.set('page', String(next));
        return params;
      },
      { replace: true },
    );
  };

  /** Buscar troca o conjunto de resultados — a página velha não vale mais. */
  const handleSearch = (term: string) => {
    setSearch(term);
    goToPage(1);
  };

  const handleTabChange = (next: CatalogTab) => {
    setTab(next);
    setSearch('');
    goToPage(1);
  };

  const filters: ListExamsQuery = {
    page,
    limit: PAGE_SIZE,
    search: search || undefined,
  };

  const { data, isLoading } = useExamList(filters);
  const exams = data?.exams ?? [];

  const { data: packagesData, isLoading: packagesLoading } = useExamPackageList({
    page,
    limit: PAGE_SIZE,
    search: search || undefined,
  });
  const packages = packagesData?.packages ?? [];

  const canEdit = user?.role !== 'attendant';
  /** Importar CSV é só admin (D-177) — o servidor recusa os demais; aqui só esconde. */
  const canImport = user?.role === 'admin';

  const handleEditClick = (exam: Exam) => {
    setEditExam(exam);
    setShowModal(true);
  };

  const handleEditPackageClick = (pkg: ExamPackage) => {
    setEditPackage(pkg);
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditExam(undefined);
    setEditPackage(undefined);
  };

  return (
    <div className="flex flex-col gap-lg p-lg h-full">
      <div className="flex justify-between items-center">
        <h1 className="font-heading text-display">Catálogo de Exames</h1>
        <div className="flex gap-sm">
          {canImport && tab === 'exams' && (
            <Button variant="secondary" onClick={() => setShowImport(true)}>
              Importar CSV
            </Button>
          )}
          {canEdit && (
            <Button variant="primary" onClick={() => setShowModal(true)}>
              {tab === 'exams' ? '+ Novo Exame' : '+ Novo Pacote'}
            </Button>
          )}
        </div>
      </div>

      <SegmentedControl
        aria-label="Aba do catálogo"
        value={tab}
        onChange={handleTabChange}
        options={[
          { value: 'exams', label: 'Exames' },
          { value: 'packages', label: 'Pacotes' },
        ]}
      />

      <SearchInput
        key={tab}
        defaultValue={search}
        onSearch={handleSearch}
        placeholder={tab === 'exams' ? 'Buscar exame...' : 'Buscar pacote...'}
      />

      {tab === 'exams' ? (
        isLoading ? (
          <div>Carregando...</div>
        ) : (
          <>
            <ExamTable
              exams={exams}
              canEdit={canEdit}
              onEdit={handleEditClick}
            />
            {data && (
              <Pagination
                pagination={data.pagination}
                onPageChange={goToPage}
                itemLabel="exames"
              />
            )}
          </>
        )
      ) : packagesLoading ? (
        <div>Carregando...</div>
      ) : (
        <>
          <PackageTable
            packages={packages}
            canEdit={canEdit}
            onEdit={handleEditPackageClick}
          />
          {packagesData && (
            <Pagination
              pagination={packagesData.pagination}
              onPageChange={goToPage}
              itemLabel="pacotes"
            />
          )}
        </>
      )}

      {showModal && tab === 'exams' && (
        <ExamModal
          exam={editExam}
          onClose={handleCloseModal}
        />
      )}

      {showImport && <ExamImportModal onClose={() => setShowImport(false)} />}

      {showModal && tab === 'packages' && (
        <PackageModal
          pkg={editPackage}
          onClose={handleCloseModal}
        />
      )}
    </div>
  );
}
