import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useExamList } from '@/api/exams';
import { useAuthStore } from '@/stores/auth.store';
import ExamTable from '@/components/catalog/ExamTable';
import ExamModal from '@/components/catalog/ExamModal';
import { Button, SearchInput } from '@/components/ui';
import { Pagination } from '@/components/shared';
import type { Exam, ListExamsQuery } from '@crm-lab/shared';

/** Mesmo default do backend (`docs/api/API_CONTRACTS.md` §4). */
const PAGE_SIZE = 20;

export default function Catalog() {
  const user = useAuthStore((s) => s.user);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editExam, setEditExam] = useState<Exam | undefined>();

  /** Página na URL (`?page=2`), pelo mesmo motivo de `/proposals`. */
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

  const filters: ListExamsQuery = {
    page,
    limit: PAGE_SIZE,
    search: search || undefined,
  };

  const { data, isLoading } = useExamList(filters);
  const exams = data?.exams ?? [];

  const canEdit = user?.role !== 'attendant';

  const handleEditClick = (exam: Exam) => {
    setEditExam(exam);
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditExam(undefined);
  };

  return (
    <div className="flex flex-col gap-lg p-lg h-full">
      <div className="flex justify-between items-center">
        <h1 className="font-heading text-display">Catálogo de Exames</h1>
        {canEdit && (
          <Button variant="primary" onClick={() => setShowModal(true)}>
            + Novo Exame
          </Button>
        )}
      </div>

      <SearchInput
        defaultValue={search}
        onSearch={handleSearch}
        placeholder="Buscar exame..."
      />

      {isLoading ? (
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
      )}

      {showModal && (
        <ExamModal
          exam={editExam}
          onClose={handleCloseModal}
        />
      )}
    </div>
  );
}
