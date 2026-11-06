import { useState } from 'react';
import type { WhatsAppPricingCategory, WhatsAppUsageCategory } from '@crm-lab/shared';
import { useWhatsAppUsage } from '@/api/channels';
import { DataTable } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { Input } from '@/components/ui';
import { formatCount, formatMoney } from '@/lib/format';

/**
 * Uso e custo ESTIMADO da Cloud API no mês (CRMLAB-141, D-312, PAGES §10).
 * Gestor e admin; só aparece com o WhatsApp em `cloud_api` (quem decide é a tela
 * de Canais). Não é a fatura da Meta: o rodapé diz isso sempre.
 */

const LABELS: Record<WhatsAppPricingCategory, string> = {
  service: 'Atendimento (serviço)',
  utility: 'Utilidade',
  marketing: 'Marketing',
  authentication: 'Autenticação',
};

/** Preço unitário com até 4 casas (a tabela da Meta tem R$ 0,3217). */
const UNIT_PRICE = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** Mês civil corrente (`YYYY-MM`) em America/Sao_Paulo. */
export function currentMonth(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  }).format(now);
}

const COLUMNS: Array<DataTableColumn<WhatsAppUsageCategory>> = [
  {
    key: 'category',
    header: 'Categoria',
    minWidth: 180,
    render: (row) => <span className="font-semibold text-text">{LABELS[row.category]}</span>,
  },
  { key: 'count', header: 'Mensagens', align: 'right', render: (row) => formatCount(row.count) },
  {
    key: 'free',
    header: 'Grátis',
    align: 'right',
    render: (row) => (row.category === 'service' ? formatCount(row.freeCount) : '—'),
  },
  { key: 'unit', header: 'Preço unitário', align: 'right', render: (row) => UNIT_PRICE.format(row.unitPrice) },
  { key: 'cost', header: 'Custo estimado', align: 'right', render: (row) => formatMoney(row.cost) },
];

export function WhatsAppUsageCard() {
  const max = currentMonth();
  const [month, setMonth] = useState(max);
  const { data, isLoading, isError } = useWhatsAppUsage(month, { enabled: month !== '' });

  const service = data?.categories.find((c) => c.category === 'service');
  const freeLeft = data && service ? Math.max(data.freeServiceAllowance - service.freeCount, 0) : null;

  return (
    <div className="flex flex-col gap-md" data-testid="whatsapp-usage">
      <div className="flex flex-wrap items-center gap-sm">
        <span className="font-body text-caption font-semibold text-neutral-700">Mês</span>
        <div className="w-[170px]">
          <Input
            type="month"
            value={month}
            max={max}
            aria-label="Mês do relatório"
            onChange={(event) => setMonth(event.target.value)}
          />
        </div>
      </div>

      {isLoading && <p className="m-0 font-body text-caption text-neutral-600">Carregando…</p>}
      {isError && (
        <p className="m-0 font-body text-caption text-danger" role="alert">
          Não foi possível carregar o uso deste mês.
        </p>
      )}

      {data && (
        <>
          <DataTable
            columns={COLUMNS}
            rows={data.categories}
            rowKey={(row) => row.category}
            minWidth={560}
          />
          <div className="flex flex-wrap items-baseline justify-between gap-sm">
            <span className="font-body text-caption text-neutral-600">
              {freeLeft !== null &&
                `Franquia de atendimento: ${formatCount(data.freeServiceAllowance)} por mês — restam ${formatCount(freeLeft)}.`}
            </span>
            <span className="font-heading text-body font-semibold text-text" data-testid="whatsapp-usage-total">
              Total estimado: {formatMoney(data.totalCost)}
            </span>
          </div>
          <p className="m-0 font-body text-caption text-neutral-600">
            Estimativa calculada pelo CRM com a tabela de preços da Meta. Não é a fatura: confira o valor
            cobrado no Gerenciador de Negócios da Meta.
          </p>
        </>
      )}
    </div>
  );
}
