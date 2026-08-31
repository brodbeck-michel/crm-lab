import { useState, useEffect } from 'react';
import type { CreateInsuranceRequest, Insurance, InsuranceType, UpdateInsuranceRequest } from '@crm-lab/shared';
import { useCreateInsurance, useInsuranceList, useUpdateInsurance } from '@/api/insurances';
import { useAuthStore } from '@/stores/auth.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { DataTable, Modal } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { Button, Chip, Input, Select, Toggle } from '@/components/ui';

/**
 * Convênios — `/settings/insurances` (PAGES.md §10 · API_CONTRACTS.md §8 ·
 * D-081/D-082).
 *
 * `GET /insurances` é para todos os papéis do tenant (§8) — a rota em si já
 * é gestor+ (`route-config.ts`). O botão de novo convênio e a coluna de
 * ações, porém, são AUSENTES do DOM para quem não é manager/admin (mesmo
 * padrão de `Settings/Channels.tsx`): não há controle de escrita a
 * desabilitar porque não existe nenhum — o servidor recusaria o POST/PATCH
 * de qualquer forma (403).
 */

const TYPE_LABEL: Record<InsuranceType, string> = {
  cooperativa: 'Cooperativa',
  medicina_grupo: 'Medicina de Grupo',
  seguradora: 'Seguradora',
  autogestao: 'Autogestão',
  especial: 'Especial',
};

const TYPE_OPTIONS: InsuranceType[] = [
  'cooperativa',
  'medicina_grupo',
  'seguradora',
  'autogestao',
  'especial',
];

export default function Insurances() {
  const role = useAuthStore((s) => s.user?.role);
  const canEdit = role === 'manager' || role === 'admin';

  const [showModal, setShowModal] = useState(false);
  const [editInsurance, setEditInsurance] = useState<Insurance | undefined>();

  const { data, isLoading } = useInsuranceList({ page: 1, limit: 100 });
  const insurances = data?.insurances ?? [];

  const handleEditClick = (insurance: Insurance) => {
    setEditInsurance(insurance);
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditInsurance(undefined);
  };

  const baseColumns: Array<DataTableColumn<Insurance>> = [
    { key: 'name', header: 'Nome', render: (insurance) => insurance.name },
    {
      key: 'officialName',
      header: 'Razão Social',
      render: (insurance) => insurance.officialName || '—',
    },
    { key: 'ansCode', header: 'Código ANS', render: (insurance) => insurance.ansCode || '—' },
    { key: 'type', header: 'Tipo', render: (insurance) => TYPE_LABEL[insurance.type] },
    {
      key: 'isActive',
      header: 'Status',
      render: (insurance) => (
        <Chip tone={insurance.isActive ? 'positive' : 'inactive'}>
          {insurance.isActive ? 'Ativo' : 'Inativo'}
        </Chip>
      ),
    },
  ];

  const columns = canEdit
    ? [
        ...baseColumns,
        {
          key: 'actions',
          header: 'Ações',
          render: (insurance: Insurance) => (
            <Button variant="secondary" size="sm" onClick={() => handleEditClick(insurance)}>
              Editar
            </Button>
          ),
        },
      ]
    : baseColumns;

  return (
    <PageContainer>
      <PageHeader
        title="Convênios"
        description="Convênios do laboratório e o preço por (exame, convênio) ficam na aba do catálogo."
        actions={
          canEdit && (
            <Button variant="primary" onClick={() => setShowModal(true)}>
              + Novo Convênio
            </Button>
          )
        }
      />

      {isLoading ? (
        <div className="font-body text-body text-neutral-600">Carregando...</div>
      ) : (
        <DataTable
          columns={columns}
          rows={insurances}
          rowKey={(insurance) => insurance.id}
          emptyMessage="Nenhum convênio ainda"
          minWidth={800}
        />
      )}

      {showModal && <InsuranceModal insurance={editInsurance} onClose={handleCloseModal} />}
    </PageContainer>
  );
}

interface InsuranceModalProps {
  insurance?: Insurance;
  onClose: () => void;
}

function InsuranceModal({ insurance, onClose }: InsuranceModalProps) {
  const insuranceId = insurance?.id;
  const isEditMode = !!insuranceId;

  const [form, setForm] = useState({
    name: '',
    officialName: '',
    ansCode: '',
    type: 'cooperativa' as InsuranceType,
    isActive: true,
  });

  const createInsurance = useCreateInsurance();
  const updateInsurance = useUpdateInsurance();

  useEffect(() => {
    if (insurance) {
      setForm({
        name: insurance.name,
        officialName: insurance.officialName || '',
        ansCode: insurance.ansCode || '',
        type: insurance.type,
        isActive: insurance.isActive,
      });
    }
  }, [insurance]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (insuranceId) {
      const updateData: UpdateInsuranceRequest = {
        name: form.name,
        officialName: form.officialName || null,
        ansCode: form.ansCode || null,
        type: form.type,
        isActive: form.isActive,
      };
      updateInsurance.mutate({ id: insuranceId, dto: updateData });
    } else {
      const createData: CreateInsuranceRequest = {
        name: form.name,
        officialName: form.officialName || undefined,
        ansCode: form.ansCode || undefined,
        type: form.type,
      };
      createInsurance.mutate(createData);
    }

    onClose();
  };

  const isLoading = createInsurance.isPending || updateInsurance.isPending;

  return (
    <Modal
      open
      onClose={onClose}
      title={isEditMode ? 'Editar Convênio' : 'Novo Convênio'}
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
          label="Razão Social"
          value={form.officialName}
          onChange={(e) => setForm({ ...form, officialName: e.target.value })}
        />

        <Input
          label="Código ANS"
          hint="Registro na ANS. Em branco = não confirmado."
          value={form.ansCode}
          onChange={(e) => setForm({ ...form, ansCode: e.target.value })}
        />

        <Select
          label="Tipo"
          value={form.type}
          onChange={(e) => setForm({ ...form, type: e.target.value as InsuranceType })}
          options={TYPE_OPTIONS.map((type) => ({ value: type, label: TYPE_LABEL[type] }))}
        />

        {isEditMode && (
          <Toggle
            checked={form.isActive}
            onChange={(isActive) => setForm({ ...form, isActive })}
            label="Ativo"
          />
        )}
      </form>
    </Modal>
  );
}
