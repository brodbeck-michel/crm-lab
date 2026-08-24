import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SubscriptionPlan, TenantUsage } from '@crm-lab/shared';
import { platformApi, queryKeys } from '@/api';
import { PageContainer, PageHeader } from '@/components/layout';
import { DataTable, EmptyState, MoneyDisplay } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { Button, Chip } from '@/components/ui';
import { formatPercent } from '@/lib/format';
import { useAuthStore } from '@/stores';

/**
 * Assinaturas & Uso — `/platform/billing` (PAGES.md §11,
 * API_CONTRACTS.md §5b "GET /platform/billing").
 *
 * Tudo aqui é agregado SEM SUJEITO: contagem de mensagens e de propostas do
 * mês corrente, nunca conteúdo nem valor de proposta de laboratório.
 *
 * Dinheiro chega no fio como número decimal (`824`, `179.8`) e é formatado só
 * na view, por `MoneyDisplay`/`lib/format` (CLAUDE.md §9). `extraMessages` é
 * derivado no backend — a tela não recalcula franquia nem preço, apenas exibe.
 */

const PLAN_LABEL: Record<SubscriptionPlan, string> = {
  starter: 'Starter',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

interface StatTileProps {
  label: string;
  children: ReactNode;
  hint?: string;
}

/** Cartão de indicador do console — só tokens, sem cor/raio literal. */
function StatTile({ label, children, hint }: StatTileProps) {
  return (
    <div className="flex flex-col gap-xs rounded-lg bg-neutral-100 px-lg py-md shadow-sm">
      <span className="font-body text-micro font-semibold uppercase text-neutral-600">{label}</span>
      <span className="text-text">{children}</span>
      {hint && <span className="font-body text-caption text-neutral-600">{hint}</span>}
    </div>
  );
}

/** Consumo da franquia — 0 incluso significa plano sem franquia, não divisão por zero. */
function usageRatio(row: TenantUsage): number {
  if (row.messagesIncluded <= 0) return 0;
  return row.messagesUsed / row.messagesIncluded;
}

export function PlatformBilling() {
  const role = useAuthStore((state) => state.user?.role);
  const isOperator = role === 'platform_operator';

  const billingQuery = useQuery({
    queryKey: queryKeys.platformBilling(),
    queryFn: () => platformApi.billing(),
    enabled: isOperator,
  });

  const columns = useMemo<Array<DataTableColumn<TenantUsage>>>(
    () => [
      {
        key: 'tenantName',
        header: 'Laboratório',
        minWidth: 200,
        render: (row) => <span className="font-semibold text-text">{row.tenantName}</span>,
      },
      {
        key: 'plan',
        header: 'Plano',
        render: (row) => <Chip tone="positive">{PLAN_LABEL[row.plan]}</Chip>,
      },
      {
        key: 'messagesIncluded',
        header: 'Franquia',
        align: 'right',
        render: (row) => <span className="tabular-nums">{row.messagesIncluded}</span>,
      },
      {
        key: 'messagesUsed',
        header: 'Mensagens no mês',
        align: 'right',
        render: (row) => (
          <span className="whitespace-nowrap tabular-nums">
            {row.messagesUsed}
            <span className="ml-xs text-caption text-neutral-600">
              ({formatPercent(usageRatio(row))})
            </span>
          </span>
        ),
      },
      {
        key: 'extraMessages',
        header: 'Excedente',
        align: 'right',
        render: (row) =>
          row.extraMessages > 0 ? (
            <Chip tone="attention">{row.extraMessages}</Chip>
          ) : (
            <span className="tabular-nums text-neutral-600">0</span>
          ),
      },
      {
        key: 'proposalCount',
        header: 'Propostas',
        align: 'right',
        render: (row) => <span className="tabular-nums">{row.proposalCount}</span>,
      },
      {
        key: 'monthlyPrice',
        header: 'Mensalidade',
        align: 'right',
        render: (row) => <MoneyDisplay value={row.monthlyPrice} />,
      },
    ],
    [],
  );

  if (!isOperator) {
    return (
      <PageContainer>
        <PageHeader title="Assinaturas & Uso" />
        <EmptyState
          message="Acesso restrito ao operador da plataforma"
          hint="Este console não faz parte da operação do laboratório."
        />
      </PageContainer>
    );
  }

  if (billingQuery.isLoading) {
    return (
      <PageContainer>
        <PageHeader title="Assinaturas & Uso" />
        <p className="font-body text-body text-neutral-600">Carregando faturamento...</p>
      </PageContainer>
    );
  }

  if (billingQuery.isError) {
    return (
      <PageContainer>
        <PageHeader title="Assinaturas & Uso" />
        <EmptyState
          message="Não foi possível carregar o faturamento"
          hint="Verifique a conexão e tente novamente."
          action={
            <Button variant="secondary" onClick={() => void billingQuery.refetch()}>
              Tentar novamente
            </Button>
          }
        />
      </PageContainer>
    );
  }

  const usage = billingQuery.data?.usage ?? [];
  const totals = billingQuery.data?.totals ?? { mrr: 0, tenants: 0, messages: 0 };

  return (
    <PageContainer>
      <PageHeader
        title="Assinaturas & Uso"
        description="Mensalidade = plano + excedente de mensagens do mês corrente. Só laboratórios ativos faturam."
      />

      <div className="grid gap-md sm:grid-cols-3">
        <StatTile label="Receita recorrente (MRR)" hint="Somente laboratórios ativos">
          <MoneyDisplay value={totals.mrr} variant="thousands" emphasis />
        </StatTile>
        <StatTile label="Laboratórios ativos">
          <span className="font-heading text-metric tabular-nums">{totals.tenants}</span>
        </StatTile>
        <StatTile label="Mensagens no mês">
          <span className="font-heading text-metric tabular-nums">{totals.messages}</span>
        </StatTile>
      </div>

      <DataTable
        columns={columns}
        rows={usage}
        rowKey={(row) => row.tenantId}
        emptyMessage="Nenhuma assinatura para faturar neste mês"
        minWidth={880}
      />
    </PageContainer>
  );
}

export default PlatformBilling;
