import { useState } from 'react';
import { useExamList } from '@/api/exams';
import { useAuthStore } from '@/stores/auth.store';
import ExamTable from '@/components/catalog/ExamTable';
import ExamModal from '@/components/catalog/ExamModal';
import { Button, SearchInput } from '@/components/ui';
import type { ListExamsQuery } from '@crm-lab/shared';

export default function Catalog() {
  const user = useAuthStore((s) => s.user);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editExamId, setEditExamId] = useState<string | undefined>();

  const filters: ListExamsQuery = {
    limit: 20,
    search: search || undefined,
  };

  const { data: exams = [], isLoading } = useExamList(filters);

  const canEdit = user?.role !== 'attendant';

  const handleEditClick = (examId: string) => {
    setEditExamId(examId);
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditExamId(undefined);
  };

  return (
    <div className="flex flex-col gap-lg p-lg h-full">
      <div className="flex justify-between items-center">
        <h1 className="text-heading-32">Catálogo de Exames</h1>
        {canEdit && (
          <Button variant="primary" onClick={() => setShowModal(true)}>
            + Novo Exame
          </Button>
        )}
      </div>

      <SearchInput
        defaultValue={search}
        onSearch={setSearch}
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
          {/* TODO: Paginação */}
        </>
      )}

      {showModal && (
        <ExamModal
          examId={editExamId}
          onClose={handleCloseModal}
        />
      )}
    </div>
  );
}
