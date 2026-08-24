import { useState, useEffect } from 'react';
import { useCreateExam, useUpdateExam } from '@/api/exams';
import type { CreateExamRequest, Exam, UpdateExamRequest } from '@crm-lab/shared';
import { Modal } from '@/components/shared';
import { Input, Button } from '@/components/ui';

interface ExamModalProps {
  /**
   * Exame da linha clicada (modo edição). Ausente ⇒ criação.
   *
   * O registro vem PRONTO da tabela. `docs/api/API_CONTRACTS.md` §4 não expõe
   * `GET /exams/:id`, e varrer `GET /exams?limit=1000` volta 400 (o zod do
   * controller corta em 100) — o formulário abria vazio.
   */
  exam?: Exam;
  onClose: () => void;
}

export default function ExamModal({ exam, onClose }: ExamModalProps) {
  const examId = exam?.id;
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

  useEffect(() => {
    if (exam) {
      setForm({
        name: exam.name,
        code: exam.code,
        description: exam.description || '',
        preparation: exam.preparation || '',
        turnaroundHours: exam.turnaroundHours?.toString() || '',
        pricePrivate: exam.pricePrivate.toString(),
        priceInsurance: exam.priceInsurance.toString(),
        isActive: exam.isActive,
      });
    }
  }, [exam]);

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
