import { useEffect, useState } from 'react';
import { useCommissionSettings, useUpdateCommissionSettings } from '@/api/commission-settings';
import { useAuthStore } from '@/stores/auth.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { Button, Input, useToast } from '@/components/ui';

/**
 * Comissão (`/settings/commissions`) — percentuais de comissão sobre venda de
 * exame e check-up (PAGES.md §19, D-113). `GET` gestor+, `PATCH` admin.
 */
export default function Commissions() {
  const role = useAuthStore((s) => s.user?.role);
  const canEdit = role === 'admin';
  const { toast } = useToast();

  const { data, isLoading } = useCommissionSettings();
  const updateCommissions = useUpdateCommissionSettings();

  const [form, setForm] = useState({
    commissionBudgetPct: '',
    commissionExamsPct: '',
    commissionCheckupPct: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data) {
      setForm({
        commissionBudgetPct: String(data.commissionBudgetPct),
        commissionExamsPct: String(data.commissionExamsPct),
        commissionCheckupPct: String(data.commissionCheckupPct),
      });
    }
  }, [data]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!data) return;
    setFieldErrors({});

    const dirty: Record<string, number> = {};
    if (Number(form.commissionBudgetPct) !== data.commissionBudgetPct) {
      dirty.commissionBudgetPct = Number(form.commissionBudgetPct);
    }
    if (Number(form.commissionExamsPct) !== data.commissionExamsPct) {
      dirty.commissionExamsPct = Number(form.commissionExamsPct);
    }
    if (Number(form.commissionCheckupPct) !== data.commissionCheckupPct) {
      dirty.commissionCheckupPct = Number(form.commissionCheckupPct);
    }
    if (Object.keys(dirty).length === 0) return;

    updateCommissions.mutate(dirty, {
      onSuccess: () => toast('Comissão atualizada.', { tone: 'positive' }),
      onError: (err) => {
        const fields = (err as { details?: { fields?: Record<string, string> } })?.details?.fields;
        setFieldErrors(fields ?? {});
        if (!fields) toast('Não foi possível salvar.', { tone: 'attention' });
      },
    });
  }

  if (isLoading) {
    return (
      <PageContainer>
        <PageHeader title="Comissão" />
        <div className="font-body text-body text-neutral-600">Carregando...</div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Comissão"
        description="Percentuais de comissão sobre venda de exame e check-up."
      />

      <form onSubmit={handleSubmit} className="space-y-md max-w-md">
        <Input
          type="number"
          label="Comissão sobre orçamento (%)"
          hint="Usado a partir da conciliação de orçamentos (Onda 13) — ainda não afeta cálculo algum."
          value={form.commissionBudgetPct}
          onChange={(e) => setForm({ ...form, commissionBudgetPct: e.target.value })}
          error={fieldErrors.commissionBudgetPct}
          disabled={!canEdit}
          min={0}
          max={100}
          step="0.01"
        />
        <Input
          type="number"
          label="Comissão sobre exames (%)"
          value={form.commissionExamsPct}
          onChange={(e) => setForm({ ...form, commissionExamsPct: e.target.value })}
          error={fieldErrors.commissionExamsPct}
          disabled={!canEdit}
          min={0}
          max={100}
          step="0.01"
        />
        <Input
          type="number"
          label="Comissão sobre check-up (%)"
          value={form.commissionCheckupPct}
          onChange={(e) => setForm({ ...form, commissionCheckupPct: e.target.value })}
          error={fieldErrors.commissionCheckupPct}
          disabled={!canEdit}
          min={0}
          max={100}
          step="0.01"
        />
        {canEdit && (
          <Button type="submit" variant="primary" loading={updateCommissions.isPending}>
            Salvar
          </Button>
        )}
      </form>
    </PageContainer>
  );
}
