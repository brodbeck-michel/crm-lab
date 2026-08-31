import { useState, useEffect } from 'react';
import { useCreateExam, useUpdateExam } from '@/api/exams';
import type { CreateExamRequest, Exam, UpdateExamRequest } from '@crm-lab/shared';
import { Modal } from '@/components/shared';
import { Input, Button, Chip, SegmentedControl } from '@/components/ui';
import ExamPricesTab from './ExamPricesTab';

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

type Tab = 'dados' | 'precos';

export default function ExamModal({ exam, onClose }: ExamModalProps) {
  const examId = exam?.id;
  const isEditMode = !!examId;

  const [tab, setTab] = useState<Tab>('dados');
  const [form, setForm] = useState({
    name: '',
    code: '',
    description: '',
    preparation: '',
    turnaroundHours: '',
    pricePrivate: '',
    priceInsurance: '',
    isActive: true,
    tussCode: '',
    ambCode: '',
    material: '',
  });
  const [synonyms, setSynonyms] = useState<string[]>([]);
  const [synonymInput, setSynonymInput] = useState('');

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
        tussCode: exam.tussCode || '',
        ambCode: exam.ambCode || '',
        material: exam.material || '',
      });
      setSynonyms(exam.synonyms);
    }
  }, [exam]);

  const addSynonym = () => {
    const value = synonymInput.trim();
    if (value.length === 0 || synonyms.includes(value)) {
      setSynonymInput('');
      return;
    }
    setSynonyms((current) => [...current, value]);
    setSynonymInput('');
  };

  const removeSynonym = (value: string) => {
    setSynonyms((current) => current.filter((synonym) => synonym !== value));
  };

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
        tussCode: form.tussCode || null,
        ambCode: form.ambCode || null,
        material: form.material || null,
        synonyms,
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
        tussCode: form.tussCode || null,
        ambCode: form.ambCode || null,
        material: form.material || null,
        synonyms,
      };
      createExam.mutate(createData);
    }

    onClose();
  };

  const isLoading = createExam.isPending || updateExam.isPending;

  return (
    <Modal
      open
      onClose={onClose}
      title={isEditMode ? 'Editar Exame' : 'Novo Exame'}
      footer={
        tab === 'dados' ? (
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
        ) : (
          <div className="flex gap-md ml-auto">
            <Button variant="secondary" onClick={onClose}>
              Fechar
            </Button>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-md">
        {isEditMode && (
          <SegmentedControl
            aria-label="Seção do exame"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'dados', label: 'Dados' },
              { value: 'precos', label: 'Preços por convênio' },
            ]}
          />
        )}

        {tab === 'precos' && examId ? (
          <ExamPricesTab examId={examId} canEdit />
        ) : (
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

            <Input
              label="Código TUSS"
              hint="Tabela 22 TISS/ANS, 8 dígitos. Em branco = não confirmado."
              value={form.tussCode}
              onChange={(e) => setForm({ ...form, tussCode: e.target.value })}
            />

            <Input
              label="Código AMB"
              hint="Código legado, para o de-para do faturamento. Em branco = não confirmado."
              value={form.ambCode}
              onChange={(e) => setForm({ ...form, ambCode: e.target.value })}
            />

            <Input
              label="Material"
              placeholder="Ex.: Sangue — tubo tampa roxa (EDTA)"
              value={form.material}
              onChange={(e) => setForm({ ...form, material: e.target.value })}
            />

            <div className="flex flex-col gap-xs">
              <span className="font-body text-caption font-semibold text-neutral-700">
                Sinônimos
              </span>
              <div className="flex flex-wrap gap-xs">
                {synonyms.map((synonym) => (
                  <Chip
                    key={synonym}
                    tone="inactive"
                    title={`Remover "${synonym}"`}
                    onClick={() => removeSynonym(synonym)}
                  >
                    {synonym} ×
                  </Chip>
                ))}
              </div>
              <div className="flex gap-sm">
                <Input
                  aria-label="Novo sinônimo"
                  placeholder="Adicionar sinônimo"
                  value={synonymInput}
                  onChange={(e) => setSynonymInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addSynonym();
                    }
                  }}
                />
                <Button type="button" variant="secondary" onClick={addSynonym}>
                  Adicionar
                </Button>
              </div>
            </div>

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
        )}
      </div>
    </Modal>
  );
}
