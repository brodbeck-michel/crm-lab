import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Attendant, CreateAttendantRequest, UpdateAttendantRequest } from '@crm-lab/shared';
import { useAttendantList, useCreateAttendant, useUpdateAttendant } from '@/api/attendants';
import { settingsApi } from '@/api/settings';
import { queryKeys } from '@/api/query-keys';
import { isApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { DataTable, Modal } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { Button, Chip, Input, SearchInput, Select, Toggle, useToast } from '@/components/ui';

/**
 * Atendentes (`/settings/attendants`) — cadastro do atendente do LIS, com
 * vínculo opcional a um login do CRM (PAGES.md §18, D-112).
 */
export default function Attendants() {
  const role = useAuthStore((s) => s.user?.role);
  const canEdit = role === 'manager' || role === 'admin';

  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editAttendant, setEditAttendant] = useState<Attendant | undefined>();

  const { data, isLoading } = useAttendantList({ page: 1, limit: 100, search: search || undefined });
  const attendants = data?.attendants ?? [];

  function handleEditClick(attendant: Attendant) {
    setEditAttendant(attendant);
    setShowModal(true);
  }

  function handleCloseModal() {
    setShowModal(false);
    setEditAttendant(undefined);
  }

  const baseColumns: Array<DataTableColumn<Attendant>> = [
    { key: 'name', header: 'Nome', render: (a) => a.name },
    {
      key: 'isActive',
      header: 'Status',
      render: (a) => (
        <Chip tone={a.isActive ? 'positive' : 'inactive'}>{a.isActive ? 'Ativo' : 'Inativo'}</Chip>
      ),
    },
    { key: 'userName', header: 'Usuário vinculado', render: (a) => a.userName ?? '— sem login —' },
  ];

  const columns = canEdit
    ? [
        ...baseColumns,
        {
          key: 'actions',
          header: 'Ações',
          render: (a: Attendant) => (
            <Button variant="secondary" size="sm" onClick={() => handleEditClick(a)}>
              Editar
            </Button>
          ),
        },
      ]
    : baseColumns;

  return (
    <PageContainer>
      <PageHeader
        title="Atendentes"
        description="Cadastro do atendente do LIS, ligável opcionalmente a um login do CRM."
        actions={
          canEdit && (
            <Button variant="primary" onClick={() => setShowModal(true)}>
              + Novo Atendente
            </Button>
          )
        }
      />

      <div className="space-y-lg">
        <SearchInput placeholder="Buscar por nome" onSearch={setSearch} aria-label="Buscar atendente" />

        {isLoading ? (
          <div className="font-body text-body text-neutral-600">Carregando...</div>
        ) : (
          <DataTable
            columns={columns}
            rows={attendants}
            rowKey={(a) => a.id}
            emptyMessage="Nenhum atendente ainda"
            minWidth={720}
          />
        )}
      </div>

      {showModal && <AttendantModal attendant={editAttendant} onClose={handleCloseModal} />}
    </PageContainer>
  );
}

interface AttendantModalProps {
  attendant?: Attendant;
  onClose: () => void;
}

function AttendantModal({ attendant, onClose }: AttendantModalProps) {
  const { toast } = useToast();
  const isEditMode = !!attendant?.id;

  const [name, setName] = useState('');
  const [userId, setUserId] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // `team` de `GET /settings/channels` (D-066) — NÃO `GET /users` (admin apenas), que
  // bloquearia o gestor de montar este seletor (a rota desta tela é gestor+, PAGES.md §18).
  const { data: channelSettings } = useQuery({
    queryKey: queryKeys.channelSettings(),
    queryFn: () => settingsApi.channels(),
  });
  const userOptions = (channelSettings?.team ?? []).filter(
    (member) => member.role !== 'platform_operator' && member.isActive,
  );
  const createAttendant = useCreateAttendant();
  const updateAttendant = useUpdateAttendant();

  useEffect(() => {
    if (attendant) {
      setName(attendant.name);
      setUserId(attendant.userId ?? '');
      setIsActive(attendant.isActive);
    }
  }, [attendant]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErrors({});

    const onError = (err: unknown) => {
      if (isApiError(err) && err.code === 'CONFLICT') {
        setFieldErrors({ name: 'Já existe um atendente com esse nome.' });
        return;
      }
      if (isApiError(err) && err.code === 'VALIDATION_ERROR') {
        setFieldErrors((err.details?.fields as Record<string, string>) ?? {});
        return;
      }
      toast('Não foi possível salvar o atendente.', { tone: 'attention' });
    };

    if (isEditMode && attendant) {
      const body: UpdateAttendantRequest = { name, userId: userId || null, isActive };
      updateAttendant.mutate(
        { id: attendant.id, dto: body },
        { onSuccess: onClose, onError },
      );
    } else {
      const body: CreateAttendantRequest = { name, userId: userId || null };
      createAttendant.mutate(body, { onSuccess: onClose, onError });
    }
  }

  const isPending = createAttendant.isPending || updateAttendant.isPending;

  return (
    <Modal
      open
      onClose={onClose}
      title={isEditMode ? 'Editar Atendente' : 'Novo Atendente'}
      footer={
        <div className="flex gap-md ml-auto">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={isPending}>
            {isEditMode ? 'Atualizar' : 'Criar'}
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-md">
        <Input
          label="Nome"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fieldErrors.name}
          required
        />
        <Select
          label="Usuário vinculado"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          options={[
            { value: '', label: '— sem login —' },
            ...userOptions.map((u) => ({ value: u.id, label: u.name })),
          ]}
          error={fieldErrors.userId}
        />
        {isEditMode && (
          <Toggle checked={isActive} onChange={setIsActive} label="Ativo" />
        )}
      </form>
    </Modal>
  );
}
