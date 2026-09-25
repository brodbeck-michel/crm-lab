import { useState } from 'react';
import { useAnalyticsConversion } from '@/api/analytics';
import MetricTile from '@/components/analytics/MetricTile';
import ConversionChart from '@/components/analytics/ConversionChart';
import RevenueChart from '@/components/analytics/RevenueChart';
import LossReasonsChart from '@/components/analytics/LossReasonsChart';
import { Input } from '@/components/ui/Input';
import { Chip } from '@/components/ui';
import { MoneyDisplay } from '@/components/shared';

export default function Analytics() {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const { data: conversion, isLoading } = useAnalyticsConversion({
    // `IsoDate` é `string` em @crm-lab/shared — nenhum cast é necessário.
    startDate: startDate === '' ? undefined : startDate,
    endDate: endDate === '' ? undefined : endDate,
  });

  if (isLoading) {
    return (
      <div className="p-lg space-y-xl">
        <h1 className="font-heading text-display">Conversão</h1>
        <div>Carregando dados...</div>
      </div>
    );
  }

  if (!conversion) {
    return (
      <div className="p-lg space-y-xl">
        <h1 className="font-heading text-display">Conversão</h1>
        <div>Nenhum dado disponível</div>
      </div>
    );
  }

  // Prepare funnel data for chart
  const funnelData = [
    { stage: 'Novo Contato', count: conversion.funnel.novoContato },
    { stage: 'Orçamento Enviado', count: conversion.funnel.orcamentoEnviado },
    { stage: 'Follow-up', count: conversion.funnel.followUp },
    { stage: 'Negociação', count: conversion.funnel.negociacao },
    { stage: 'Ganho', count: conversion.funnel.ganho },
    { stage: 'Perdido', count: conversion.funnel.perdido },
  ];

  // Prepare loss reasons data
  const lossReasonsData = Object.entries(conversion.lossReasons).map(([reason, count]) => ({
    reason,
    count,
  }));

  // Get total proposals created for metric
  const proposalsCreated =
    conversion.funnel.novoContato +
    conversion.funnel.orcamentoEnviado +
    conversion.funnel.followUp +
    conversion.funnel.negociacao +
    conversion.funnel.ganho +
    conversion.funnel.perdido;

  const hasRealized =
    conversion.realized.paidCount > 0 || conversion.realized.wonFromLis > 0;

  return (
    <div className="p-lg space-y-xl">
      <h1 className="font-heading text-display">Conversão</h1>

      {/*
        Atendente recebe `partial: true` do backend e só as próprias métricas
        (docs/frontend/PAGES.md §8 · pedido do Agent-API-Analytics em
        docs/STATUS.md). Sem este aviso o número parece ser o do laboratório.
      */}
      {conversion.partial && (
        <div role="status" className="flex flex-wrap items-center gap-sm">
          <Chip tone="attention">Versão parcial</Chip>
          <span className="font-body text-body text-neutral-600">
            Você está vendo apenas as suas métricas. As métricas do time ficam
            disponíveis para gestor e administrador.
          </span>
        </div>
      )}

      {/* Period Filters */}
      <div className="flex gap-lg flex-wrap">
        <Input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          placeholder="Data inicial"
          aria-label="Data inicial"
        />
        <Input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          placeholder="Data final"
          aria-label="Data final"
        />
      </div>

      {/* Metric Tiles Grid */}
      <div className="grid grid-cols-5 gap-lg">
        <MetricTile label="Receita" value={conversion.revenue} variant="money" />
        {/* CRMLAB-52/D-119: pago no LIS, janela de pagamento. Não soma com a receita do CRM. */}
        <MetricTile
          label="Receita realizada (LIS)"
          value={hasRealized ? conversion.realized.paidValue : undefined}
          variant="money"
          caption={
            hasRealized
              ? `${conversion.realized.paidCount} pagamentos · ${conversion.realized.wonFromLis} ganhos confirmados pelo LIS`
              : 'Informe o nº do orçamento do LIS nas propostas'
          }
        />
        <MetricTile label="Ticket Médio" value={conversion.averageTicket} variant="money" />
        <MetricTile label="Taxa de Conversão" value={conversion.funnel.conversionRate} variant="percent" />
        <MetricTile label="Propostas Criadas" value={proposalsCreated} variant="number" />
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-2 gap-lg">
        <ConversionChart data={funnelData} />
        <RevenueChart
          data={[
            {
              month: 'Total',
              revenue: conversion.revenue,
            },
          ]}
        />
      </div>

      {/* Loss Reasons Chart */}
      {lossReasonsData.length > 0 && <LossReasonsChart data={lossReasonsData} />}

      {/* Top Performers Section (if available and not partial view) */}
      {conversion.topPerformers && conversion.topPerformers.length > 0 && !conversion.partial && (
        <div className="bg-neutral-100 p-lg rounded-md shadow-sm space-y-lg">
          <h3 className="font-heading text-section">Melhores Desempenhos</h3>
          <div className="space-y-sm">
            {conversion.topPerformers.map((performer) => (
              <div key={performer.userId} className="flex justify-between items-center p-md border border-neutral-200 rounded-md">
                <div>
                  <p className="font-medium">{performer.name}</p>
                  <p className="text-caption text-neutral-600">{performer.conversions} conversões</p>
                </div>
                <div className="text-right font-semibold">
                  <MoneyDisplay value={performer.revenue} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
