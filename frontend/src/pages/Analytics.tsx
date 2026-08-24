import { useState } from 'react';
import { useAnalyticsConversion } from '@/api/analytics';
import MetricTile from '@/components/analytics/MetricTile';
import ConversionChart from '@/components/analytics/ConversionChart';
import RevenueChart from '@/components/analytics/RevenueChart';
import LossReasonsChart from '@/components/analytics/LossReasonsChart';
import { Input } from '@/components/ui/Input';

export default function Analytics() {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const { data: conversion, isLoading } = useAnalyticsConversion({
    startDate: startDate ? (startDate as any) : undefined,
    endDate: endDate ? (endDate as any) : undefined,
  });

  if (isLoading) {
    return (
      <div className="p-5 space-y-6">
        <h1 className="text-heading-32">Conversão</h1>
        <div>Carregando dados...</div>
      </div>
    );
  }

  if (!conversion) {
    return (
      <div className="p-5 space-y-6">
        <h1 className="text-heading-32">Conversão</h1>
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

  return (
    <div className="p-5 space-y-6">
      <h1 className="text-heading-32">Conversão</h1>

      {/* Period Filters */}
      <div className="flex gap-4 flex-wrap">
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
      <div className="grid grid-cols-4 gap-4">
        <MetricTile label="Receita" value={conversion.revenue} variant="money" />
        <MetricTile label="Ticket Médio" value={conversion.averageTicket} variant="money" />
        <MetricTile label="Taxa de Conversão" value={conversion.funnel.conversionRate} variant="percent" />
        <MetricTile label="Propostas Criadas" value={proposalsCreated} variant="number" />
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-2 gap-4">
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
        <div className="bg-white p-5 rounded-md shadow-sm space-y-4">
          <h3 className="text-heading-20 font-semibold">Melhores Desempenhos</h3>
          <div className="space-y-2">
            {conversion.topPerformers.map((performer) => (
              <div key={performer.userId} className="flex justify-between items-center p-3 border rounded">
                <div>
                  <p className="font-medium">{performer.name}</p>
                  <p className="text-sm text-neutral-600">{performer.conversions} conversões</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold">
                    {new Intl.NumberFormat('pt-BR', {
                      style: 'currency',
                      currency: 'BRL',
                    }).format(performer.revenue)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
