import { useEffect, useState } from 'react';
import { useExamList } from '@/api/exams';
import { useCreateExamPackage, useUpdateExamPackage } from '@/api/exam-packages';
import type { CreateExamPackageRequest, ExamPackage, UpdateExamPackageRequest } from '@crm-lab/shared';
import { calculatePackagePrivatePrice } from '@crm-lab/shared';
import { Modal } from '@/components/shared';
import { Input, Button, SearchInput, SegmentedControl } from '@/components/ui';
import { MoneyDisplay } from '@/components/shared/MoneyDisplay';
import PackagePricesTab from './PackagePricesTab';

interface PackageModalProps {
  /** Pacote da linha clicada (modo edição). Ausente ⇒ criação. */
  pkg?: ExamPackage;
  onClose: () => void;
}

type Tab = 'dados' | 'precos';

export default function PackageModal({ pkg, onClose }: PackageModalProps) {
  const packageId = pkg?.id;
  const isEditMode = !!packageId;

  const [tab, setTab] = useState<Tab>('dados');
  const [name, setName] = useState('');
  const [discountPercent, setDiscountPercent] = useState('0');
  const [isActive, setIsActive] = useState(true);
  const [examIds, setExamIds] = useState<string[]>([]);
  const [examSearch, setExamSearch] = useState('');

  const createPackage = useCreateExamPackage();
  const updatePackage = useUpdateExamPackage();

  /**
   * Lista para o seletor de exames — só ativos (mesma regra do backend,
   * `assertExamIdsActive`), até 100 (teto do contrato §4). Sem paginação: é um
   * seletor de checkbox, não uma tabela.
   */
  const { data: examsData, isLoading: examsLoading } = useExamList({
    active: true,
    search: examSearch || undefined,
    limit: 100,
  });
  const exams = examsData?.exams ?? [];

  useEffect(() => {
    if (pkg) {
      setName(pkg.name);
      setDiscountPercent(pkg.discountPercent.toString());
      setIsActive(pkg.isActive);
      setExamIds(pkg.items.map((item) => item.examId));
    }
  }, [pkg]);

  const toggleExam = (examId: string) => {
    setExamIds((current) =>
      current.includes(examId) ? current.filter((id) => id !== examId) : [...current, examId],
    );
  };

  /**
   * Prévia do preço particular ENQUANTO o usuário monta o pacote — mesma
   * função do backend (`@crm-lab/shared`), a partir do preço corrente de cada
   * exame já carregado na lista. Some exames selecionados fora da busca atual
   * não entram na prévia (a lista não busca todos os selecionados de uma vez);
   * o valor real vem sempre do backend depois de salvar.
   */
  const selectedExams = exams.filter((exam) => examIds.includes(exam.id));
  const previewPrice = calculatePackagePrivatePrice(
    selectedExams.map((exam) => ({ pricePrivate: exam.pricePrivate })),
    parseFloat(discountPercent) || 0,
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const discount = parseFloat(discountPercent) || 0;

    if (packageId) {
      const data: UpdateExamPackageRequest = {
        name,
        examIds,
        discountPercent: discount,
        isActive,
      };
      updatePackage.mutate({ id: packageId, data });
    } else {
      const data: CreateExamPackageRequest = { name, examIds, discountPercent: discount };
      createPackage.mutate(data);
    }

    onClose();
  };

  const isLoading = createPackage.isPending || updatePackage.isPending;
  const canSubmit = name.trim().length > 0 && examIds.length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={isEditMode ? 'Editar Pacote' : 'Novo Pacote'}
      footer={
        tab === 'dados' ? (
          <div className="flex gap-md ml-auto">
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={isLoading || !canSubmit}
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
            aria-label="Seção do pacote"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'dados', label: 'Dados' },
              { value: 'precos', label: 'Preços por convênio' },
            ]}
          />
        )}

        {tab === 'precos' && packageId ? (
          <PackagePricesTab packageId={packageId} canEdit />
        ) : (
          <form onSubmit={handleSubmit} className="space-y-md">
            <Input label="Nome" value={name} onChange={(e) => setName(e.target.value)} required />

            <Input
              label="Desconto (%)"
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={discountPercent}
              onChange={(e) => setDiscountPercent(e.target.value)}
            />

            <div className="flex flex-col gap-xs">
              <span className="font-body text-caption font-semibold text-neutral-700">
                Exames incluídos
              </span>
              <SearchInput
                placeholder="Buscar exame..."
                onSearch={setExamSearch}
              />
              <div className="flex flex-col gap-xs max-h-[240px] overflow-y-auto border rounded-md p-sm">
                {examsLoading ? (
                  <span className="text-body text-neutral-600">Carregando...</span>
                ) : exams.length === 0 ? (
                  <span className="text-body text-neutral-600">Nenhum exame encontrado</span>
                ) : (
                  exams.map((exam) => (
                    <label
                      key={exam.id}
                      className="flex items-center gap-sm p-xs rounded-md hover:bg-neutral-100"
                    >
                      <input
                        type="checkbox"
                        checked={examIds.includes(exam.id)}
                        onChange={() => toggleExam(exam.id)}
                        className="h-4 w-4"
                      />
                      <span className="flex-1 min-w-0 truncate text-body">{exam.name}</span>
                      <MoneyDisplay value={exam.pricePrivate} />
                    </label>
                  ))
                )}
              </div>
              <span className="font-body text-caption text-neutral-600">
                {examIds.length} exame(s) selecionado(s)
                {examIds.length > 0 && (
                  <>
                    {' — prévia: '}
                    <MoneyDisplay value={previewPrice} />
                  </>
                )}
              </span>
            </div>

            {isEditMode && (
              <div className="flex items-center gap-sm">
                <input
                  type="checkbox"
                  id="pkg-isActive"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="h-4 w-4"
                />
                <label htmlFor="pkg-isActive" className="text-body">
                  Ativo
                </label>
              </div>
            )}
          </form>
        )}
      </div>
    </Modal>
  );
}
