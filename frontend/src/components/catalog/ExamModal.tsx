import { useState, useEffect } from 'react';
import { useCreateExam, useUpdateExam, useExamList } from '@/api/exams';
import type { CreateExamRequest, UpdateExamRequest } from '@crm-lab/shared';
import { Modal } from '@/components/shared';
import { Input, Button } from '@/components/ui';

interface ExamModalProps {
  examId?: string;
  onClose: () => void;
}

export default function ExamModal({ examId, onClose }: ExamModalProps) {
  const [form, setForm] = useState({
    name: '',
    code: '',
    description: '',
    preparation: '',
    turnaroundHours: '',
    pricePrivate: '',
    priceInsurance: '',
    isActive: true,
  });

  const createExam = useCreateExam();
  const updateExam = useUpdateExam();

  // Fetch exam if editing
  const { data: allExams } = useExamList({ limit: 1000 });
  const editingExam = examId && allExams?.find((e) => e.id === examId);

  useEffect(() => {
    if (editingExam) {
      setForm({
        name: editingExam.name,
        code: editingExam.code,
        description: editingExam.description || '',
        preparation: editingExam.preparation || '',
        turnaroundHours: editingExam.turnaroundHours?.toString() || '',
        pricePrivate: editingExam.pricePrivate.toString(),
        priceInsurance: editingExam.priceInsurance.toString(),
        isActive: editingExam.isActive,
      });
    }
  }, [editingExam]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const pricePrivate = parseFloat(form.pricePrivate) || 0;
    const priceInsurance = parseFloat(form.priceInsurance) || 0;
    const turnaroundHours = form.turnaroundHours ? parseInt(form.turnaroundHours, 10) : null;

    if (examId) {
      const updateData: UpdateExamRequest = {
        name: form.name,
        description: form.description || null,
        preparation: form.preparation || null,
        turnaroundHours,
        pricePrivate,
        priceInsurance,
        isActive: form.isActive,
      };
      updateExam.mutate({ id: examId, data: updateData });
    } else {
      const createData: CreateExamRequest = {
        name: form.name,
        code: form.code,
        description: form.description || undefined,
        preparation: form.preparation || undefined,
        turnaroundHours,
        pricePrivate,
        priceInsurance,
      };
      createExam.mutate(createData);
    }

    onClose();
  };

  const isLoading = createExam.isPending || updateExam.isPending;
  const isEditMode = !!examId;

  return (
    <Modal
      open
      onClose={onClose}
      title={isEditMode ? 'Editar Exame' : 'Novo Exame'}
      footer={
        <div className="flex gap-md ml-auto">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={isLoading}
            loading={isLoading}
          >
            {isEditMode ? 'Atualizar' : 'Criar'}
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-md">
        <Input
          label="Nome"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />

        <Input
          label="Código"
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value })}
        />

        <Input
          label="Descrição"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />

        <Input
          label="Preparo"
          value={form.preparation}
          onChange={(e) => setForm({ ...form, preparation: e.target.value })}
        />

        <Input
          label="Prazo (horas)"
          type="number"
          min="0"
          value={form.turnaroundHours}
          onChange={(e) => setForm({ ...form, turnaroundHours: e.target.value })}
        />

        <Input
          label="Preço Particular (R$)"
          type="number"
          step="0.01"
          min="0"
          value={form.pricePrivate}
          onChange={(e) => setForm({ ...form, pricePrivate: e.target.value })}
          required
        />

        <Input
          label="Preço Convênio (R$)"
          type="number"
          step="0.01"
          min="0"
          value={form.priceInsurance}
          onChange={(e) => setForm({ ...form, priceInsurance: e.target.value })}
          required
        />

        <div className="flex items-center gap-sm">
          <input
            type="checkbox"
            id="isActive"
            checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
            className="h-4 w-4"
          />
          <label htmlFor="isActive" className="text-body">
            Ativo
          </label>
        </div>
      </form>
    </Modal>
  );
}
