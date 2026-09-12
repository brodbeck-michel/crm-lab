import { useState } from 'react';
import type { CreateSaleRequest, Sale, SaleKind } from '@crm-lab/shared';
import { useAttendantList } from '@/api/attendants';
import { useCreateSale, useDeleteSale, useSaleList, useSalesSummary } from '@/api/sales';
import { isApiError } from '@/api/client';
import { useAuthStore } from '@/stores/auth.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { Button, Input, Select, TextArea, useToast } from '@/components/ui';
import { DataTable, MoneyDisplay, Modal, Pagination } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { KpiCard } from '@/components/lis/KpiCard';
import { PeriodFilter, defaultPeriod } from '@/components/lis/PeriodFilter';
import type { Period } from '@/components/lis/PeriodFilter';
import { formatIsoDay } from '@/lib/format';

const KIND_LABEL: Record<SaleKind, string> = { exams: 'Exames', checkup: 'Check-up' };

/**
 * Vendas (`/sales`) — lançamento de vendas avulsas e comissão (PAGES.md §17).
 * Atendente vê/lança só as próprias (D-112, recorte do SERVIDOR); a tela só
 * evita pedir um `attendantId` que o próprio atendente não escolhe.
 */
export default function Sales() {
  const role = useAuthStore((s) => s.user?.role);
  const canPickAttendant = role === 'manager' || role === 'admin';
  const { toast } = useToast();

  const [period, setPeriod] = useState<Period>(defaultPeriod());
  const [attendantId, setAttendantId] = useState('');
  const [kind, setKind] = useState<SaleKind | ''>('');
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);

  const { data: attendants } = useAttendantList({ active: true, limit: 100 });
  const { data: summary } = useSalesSummary({
    startDate: period.startDate,
    endDate: period.endDate,
    attendantId: canPickAttendant ? attendantId || undefined : undefined,
  });
  const { data, isLoading } = useSaleList({
    page,
    limit: 20,
    startDate: period.startDate,
    endDate: period.endDate,
    attendantId: canPickAttendant ? attendantId || undefined : undefined,
    kind: kind || undefined,
  });

  const deleteSale = useDeleteSale();

  function handleDelete(sale: Sale) {
    if (!window.confirm('Apagar esta venda?')) return;
    deleteSale.mutate(sale.id, {
      onError: () => toast('Não foi possível apagar a venda.', { tone: 'attention' }),
    });
  }

  const columns: Array<DataTableColumn<Sale>> = [
    { key: 'soldOn', header: 'Data', render: (s) => formatIsoDay(s.soldOn) },
    { key: 'code', header: 'Código', render: (s) => s.code ?? '—' },
    { key: 'kind', header: 'Tipo', render: (s) => KIND_LABEL[s.kind] },
    { key: 'exams', header: 'Exames', render: (s) => s.exams ?? '—' },
    ...(canPickAttendant
      ? [{ key: 'attendantName', header: 'Atendente', render: (s: Sale) => s.attendantName } as DataTableColumn<Sale>]
      : []),
    { key: 'value', header: 'Valor', align: 'right' as const, render: (s) => <MoneyDisplay value={s.value} /> },
    {
      key: 'actions',
      header: 'Ações',
      render: (s) => (
        <Button variant="destructive" size="sm" onClick={() => handleDelete(s)}>
          Apagar
        </Button>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Vendas"
        description="Vendas avulsas de exame e check-up, e a comissão sobre elas."
        actions={
          <Button variant="primary" onClick={() => setShowForm(true)}>
            + Lançar venda
          </Button>
        }
      />

      <div className="space-y-lg">
        <PeriodFilter
          value={period}
          onChange={(p) => {
            setPeriod(p);
            setPage(1);
          }}
        />

        <div className="flex flex-wrap gap-md">
          {canPickAttendant && (
            <Select
              label="Atendente"
              value={attendantId}
              onChange={(e) => {
                setAttendantId(e.target.value);
                setPage(1);
              }}
              options={[
                { value: '', label: 'Todos' },
                ...(attendants?.attendants.map((a) => ({ value: a.id, label: a.name })) ?? []),
              ]}
            />
          )}
          <Select
            label="Tipo"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as SaleKind | '');
              setPage(1);
            }}
            options={[
              { value: '', label: 'Todos' },
              { value: 'exams', label: 'Exames' },
              { value: 'checkup', label: 'Check-up' },
            ]}
          />
        </div>

        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-lg">
            <KpiCard label="Vendas — Exames" value={summary.byKind.exams.value} variant="money" />
            <KpiCard label="Comissão — Exames" value={summary.byKind.exams.commissionValue} variant="money" />
            <KpiCard label="Vendas — Check-up" value={summary.byKind.checkup.value} variant="money" />
            <KpiCard label="Comissão total" value={summary.commissionTotal} variant="money" />
          </div>
        )}

        {isLoading ? (
          <div className="font-body text-body text-neutral-600">Carregando...</div>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={data?.sales ?? []}
              rowKey={(s) => s.id}
              emptyMessage="Nenhuma venda lançada ainda"
              minWidth={800}
            />
            {data && (
              <Pagination pagination={data.pagination} onPageChange={setPage} itemLabel="vendas" />
            )}
          </>
        )}
      </div>

      {showForm && (
        <SaleForm
          canPickAttendant={canPickAttendant}
          attendants={attendants?.attendants ?? []}
          onClose={() => setShowForm(false)}
        />
      )}
    </PageContainer>
  );
}

interface SaleFormProps {
  canPickAttendant: boolean;
  attendants: Array<{ id: string; name: string }>;
  onClose: () => void;
}

function SaleForm({ canPickAttendant, attendants, onClose }: SaleFormProps) {
  const { toast } = useToast();
  const createSale = useCreateSale();

  const [form, setForm] = useState({
    attendantId: '',
    soldOn: new Date().toISOString().slice(0, 10),
    code: '',
    value: '',
    exams: '',
    kind: 'exams' as SaleKind,
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldErrors({});

    const body: CreateSaleRequest = {
      attendantId: canPickAttendant ? form.attendantId || undefined : undefined,
      soldOn: form.soldOn,
      code: form.code || undefined,
      value: Number(form.value),
      exams: form.exams || undefined,
      kind: form.kind,
    };

    createSale.mutate(body, {
      onSuccess: () => {
        toast('Venda lançada.', { tone: 'positive' });
        onClose();
      },
      onError: (err) => {
        if (isApiError(err) && err.code === 'VALIDATION_ERROR') {
          const fields = err.details?.fields as Record<string, string> | undefined;
          setFieldErrors(fields ?? {});
          return;
        }
        if (isApiError(err) && err.code === 'SALE_ATTENDANT_NOT_LINKED') {
          toast(
            'Seu usuário ainda não está ligado a um atendente — peça a um gestor para vincular em Configurações → Atendentes.',
            { tone: 'attention' },
          );
          return;
        }
        toast('Não foi possível lançar a venda.', { tone: 'attention' });
      },
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Lançar venda"
      footer={
        <div className="flex gap-md ml-auto">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={createSale.isPending}>
            Lançar
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-md">
        {canPickAttendant && (
          <Select
            label="Atendente"
            value={form.attendantId}
            onChange={(e) => setForm({ ...form, attendantId: e.target.value })}
            options={attendants.map((a) => ({ value: a.id, label: a.name }))}
            error={fieldErrors.attendantId}
          />
        )}
        <Input
          type="date"
          label="Data da venda"
          value={form.soldOn}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(e) => setForm({ ...form, soldOn: e.target.value })}
          error={fieldErrors.soldOn}
        />
        <Select
          label="Tipo"
          value={form.kind}
          onChange={(e) => setForm({ ...form, kind: e.target.value as SaleKind })}
          options={[
            { value: 'exams', label: 'Exames' },
            { value: 'checkup', label: 'Check-up' },
          ]}
        />
        <Input
          label="Código"
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value })}
          error={fieldErrors.code}
        />
        <Input
          type="number"
          label="Valor"
          value={form.value}
          onChange={(e) => setForm({ ...form, value: e.target.value })}
          error={fieldErrors.value}
          required
        />
        <TextArea
          label="Exames"
          value={form.exams}
          onChange={(e) => setForm({ ...form, exams: e.target.value })}
          error={fieldErrors.exams}
        />
      </form>
    </Modal>
  );
}
