import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  VISIT_PURPOSE_COLORS,
  VISIT_PURPOSE_COLOR_LABELS,
  VISIT_PURPOSE_NAME_MAX_LENGTH,
  type UpdateVisitPurposeRequest,
  type VisitPurpose,
  type VisitPurposeColor,
} from '@crm-lab/shared';
import { useVisitPurposes, visitPurposesApi } from '@/api/visit-purposes';
import { isApiError } from '@/api/client';
import { mapFieldErrors } from '@/api/error-handler';
import { queryKeys, queryScopes } from '@/api/query-keys';
import { useApiErrorHandler } from '@/hooks';
import { useAuthStore } from '@/stores/auth.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { DataTable, Modal } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { Button, Chip, Input, Toggle, cn } from '@/components/ui';
import { PURPOSE_STYLES } from '@/pages/Visitation/agenda-ui';

/**
 * Finalidades de visita — `/settings/visit-purposes`, aba "Finalidades" de
 * Cadastros (PAGES.md §10 · API_CONTRACTS.md §14 · CRMLAB-190, D-330).
 *
 * A rota já é gestor+ (`route-config.ts`); mesmo assim os controles de escrita
 * só existem no DOM para manager/admin (padrão de `Insurances.tsx`). Sem
 * excluir: inativar tira a finalidade das visitas novas, as antigas a mantêm.
 */
export default function VisitPurposes() {
  const role = useAuthStore((s) => s.user?.role);
  const canEdit = role === 'manager' || role === 'admin';
  const queryClient = useQueryClient();
  const handleApiError = useApiErrorHandler();

  const [modal, setModal] = useState<{ purpose?: VisitPurpose } | null>(null);
  const { data, isLoading } = useVisitPurposes();
  const purposes = data?.purposes ?? [];

  const reorder = useMutation({
    mutationFn: async ([a, b]: [VisitPurpose, VisitPurpose]) => {
      // Troca o sortOrder com a vizinha; ordens iguais viram vizinhas distintas.
      const [orderA, orderB] = a.sortOrder === b.sortOrder ? [b.sortOrder + 1, a.sortOrder] : [b.sortOrder, a.sortOrder];
      await visitPurposesApi.update(a.id, { sortOrder: orderA });
      await visitPurposesApi.update(b.id, { sortOrder: orderB });
    },
    onError: handleApiError,
    onSettled: () => invalidatePurposes(queryClient),
  });

  const move = (index: number, delta: -1 | 1) => {
    const a = purposes[index];
    const b = purposes[index + delta];
    if (a && b) reorder.mutate([a, b]);
  };

  const baseColumns: Array<DataTableColumn<VisitPurpose>> = [
    {
      key: 'name',
      header: 'Finalidade',
      render: (purpose) => <PurposeSample name={purpose.name} color={purpose.color} />,
    },
    { key: 'color', header: 'Cor', render: (purpose) => VISIT_PURPOSE_COLOR_LABELS[purpose.color] },
    {
      key: 'isActive',
      header: 'Status',
      render: (purpose) => (
        <Chip tone={purpose.isActive ? 'positive' : 'inactive'}>
          {purpose.isActive ? 'Ativa' : 'Inativa'}
        </Chip>
      ),
    },
  ];

  const columns: Array<DataTableColumn<VisitPurpose>> = canEdit
    ? [
        ...baseColumns,
        {
          key: 'actions',
          header: 'Ações',
          render: (purpose) => {
            const index = purposes.findIndex((p) => p.id === purpose.id);
            return (
              <div className="flex items-center gap-sm">
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={`Subir ${purpose.name}`}
                  disabled={index <= 0 || reorder.isPending}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={`Descer ${purpose.name}`}
                  disabled={index >= purposes.length - 1 || reorder.isPending}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setModal({ purpose })}>
                  Editar
                </Button>
              </div>
            );
          },
        },
      ]
    : baseColumns;

  return (
    <PageContainer>
      <PageHeader
        title="Finalidades de visita"
        description="Para que serve cada visita médica. A cor pinta a visita na agenda."
        actions={
          canEdit && (
            <Button variant="primary" onClick={() => setModal({})}>
              + Nova finalidade
            </Button>
          )
        }
      />

      {isLoading ? (
        <div className="font-body text-body text-neutral-600">Carregando...</div>
      ) : (
        <DataTable
          columns={columns}
          rows={purposes}
          rowKey={(purpose) => purpose.id}
          emptyMessage="Nenhuma finalidade ainda"
          minWidth={640}
        />
      )}

      {modal && <PurposeModal purpose={modal.purpose} onClose={() => setModal(null)} />}
    </PageContainer>
  );
}

function invalidatePurposes(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.visitPurposes() });
  // A visita carrega `purpose { name, color }`: nome/cor novos precisam chegar à agenda.
  void queryClient.invalidateQueries({ queryKey: queryScopes.visits });
}

/** Amostra como sai na agenda: bloco na cor da finalidade com o nome. */
function PurposeSample({ name, color }: { name: string; color: VisitPurposeColor }) {
  return (
    <span
      data-purpose-color={color}
      className={cn(
        'inline-flex max-w-full items-center rounded-md px-sm py-xs text-body font-semibold',
        PURPOSE_STYLES[color].bg,
        PURPOSE_STYLES[color].ink,
      )}
    >
      <span className="truncate">{name}</span>
    </span>
  );
}

interface PurposeModalProps {
  purpose?: VisitPurpose;
  onClose: () => void;
}

function PurposeModal({ purpose, onClose }: PurposeModalProps) {
  const isEdit = !!purpose;
  const queryClient = useQueryClient();
  const handleApiError = useApiErrorHandler();
  const [name, setName] = useState(purpose?.name ?? '');
  const [color, setColor] = useState<VisitPurposeColor>(purpose?.color ?? 'azul');
  const [isActive, setIsActive] = useState(purpose?.isActive ?? true);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: () => {
      if (!purpose) return visitPurposesApi.create({ name: name.trim(), color });
      const dto: UpdateVisitPurposeRequest = {};
      if (name.trim() !== purpose.name) dto.name = name.trim();
      if (color !== purpose.color) dto.color = color;
      if (isActive !== purpose.isActive) dto.isActive = isActive;
      return visitPurposesApi.update(purpose.id, dto);
    },
    onSuccess: () => {
      invalidatePurposes(queryClient);
      onClose();
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        const fields = mapFieldErrors(error.details);
        if (Object.keys(fields).length > 0) {
          setFieldErrors(fields);
          return;
        }
      }
      handleApiError(error);
    },
  });

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!name.trim()) {
      setFieldErrors({ name: 'Informe o nome' });
      return;
    }
    setFieldErrors({});
    save.mutate();
  };

  const sampleName = name.trim() || 'Exemplo';

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? 'Editar finalidade' : 'Nova finalidade'}
      footer={
        <div className="ml-auto flex gap-md">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={() => submit()} loading={save.isPending} disabled={save.isPending}>
            {isEdit ? 'Salvar' : 'Criar'}
          </Button>
        </div>
      }
    >
      <form onSubmit={submit} className="space-y-md">
        <Input
          label="Nome"
          value={name}
          maxLength={VISIT_PURPOSE_NAME_MAX_LENGTH}
          onChange={(e) => setName(e.target.value)}
          error={fieldErrors.name}
          required
        />
        <div>
          <span id="purpose-color-label" className="mb-xs block text-caption font-semibold text-neutral-700">
            Cor
          </span>
          <div role="radiogroup" aria-labelledby="purpose-color-label" className="grid grid-cols-2 gap-sm md:grid-cols-4">
            {VISIT_PURPOSE_COLORS.map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={color === key}
                aria-label={VISIT_PURPOSE_COLOR_LABELS[key]}
                onClick={() => setColor(key)}
                className={cn(
                  'flex min-w-0 items-center rounded-md border-2 px-sm py-xs text-left text-body font-semibold',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  PURPOSE_STYLES[key].bg,
                  PURPOSE_STYLES[key].ink,
                  color === key ? PURPOSE_STYLES[key].border : 'border-transparent',
                )}
              >
                <span className="truncate">{sampleName}</span>
              </button>
            ))}
          </div>
          {fieldErrors.color && <p className="mt-xs text-caption text-accent">{fieldErrors.color}</p>}
        </div>
        {isEdit && <Toggle checked={isActive} onChange={setIsActive} label="Ativa" />}
      </form>
    </Modal>
  );
}
