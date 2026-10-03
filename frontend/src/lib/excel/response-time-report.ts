import type { ResponseTimeReport, ResponseTimeSummary } from '@crm-lab/shared';

/**
 * Excel "Tempo de resposta" (CRMLAB-83, D-257) — gerado no CLIENTE com `xlsx`,
 * como o de comissões (D-123): sai do MESMO relatório que a tela mostra, sem
 * segundo fetch. Minutos ÚTEIS em número (não texto), para a planilha somar e
 * ordenar.
 *
 * Abas: "Ranking" (uma linha por quem respondeu + TOTAL), "Por dia" (do
 * recorte escolhido na tela: laboratório ou uma atendente) e "Sem resposta".
 */

const RANKING_HEADER = [
  'Atendente',
  'Respondidos',
  'Mediana (min)',
  'Média (min)',
  '1ª resposta: qtde',
  '1ª resposta: mediana (min)',
  '1ª resposta: média (min)',
  'Até 5 min',
  '5–15 min',
  '15–60 min',
  'Mais de 1 h',
];

function rankingRow(name: string, s: ResponseTimeSummary): Array<string | number | null> {
  return [
    name,
    s.answered,
    s.medianMinutes,
    s.averageMinutes,
    s.firstResponse.answered,
    s.firstResponse.medianMinutes,
    s.firstResponse.averageMinutes,
    s.buckets.upTo5,
    s.buckets.upTo15,
    s.buckets.upTo60,
    s.buckets.over60,
  ];
}

/** Nome do arquivo — exportado para o teste conferir sem abrir a planilha. */
export function responseTimeFileName(report: ResponseTimeReport): string {
  return `tempo-de-resposta-${report.period.startDate}-${report.period.endDate}.xlsx`;
}

export async function generateResponseTimeExcel(
  report: ResponseTimeReport,
  /** `responderId` do recorte da aba "Por dia"; `null` = laboratório inteiro. */
  responderId: string | null,
): Promise<void> {
  const XLSX = await import('xlsx');

  const ranking = XLSX.utils.aoa_to_sheet([
    RANKING_HEADER,
    ...report.responders.map((r) => rankingRow(r.name, r)),
    rankingRow('TOTAL DO LABORATÓRIO', report.total),
  ]);
  ranking['!cols'] = [{ wch: 26 }, ...RANKING_HEADER.slice(1).map(() => ({ wch: 16 }))];

  const selected = responderId === null ? null : report.responders.find((r) => r.responderId === responderId);
  const daily = selected
    ? XLSX.utils.aoa_to_sheet([
        [`Recorte: ${selected.name}`],
        ['Data', 'Respondidos', 'Mediana (min)', 'Média (min)'],
        ...selected.daily.map((d) => [d.date, d.answered, d.medianMinutes, d.averageMinutes]),
      ])
    : XLSX.utils.aoa_to_sheet([
        ['Recorte: laboratório inteiro'],
        ['Data', 'Respondidos', 'Mediana (min)', 'Média (min)', 'Sem resposta'],
        ...report.total.daily.map((d) => [d.date, d.answered, d.medianMinutes, d.averageMinutes, d.unanswered]),
      ]);
  daily['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];

  const { waiting, closed, conversations } = report.total.unanswered;
  const unanswered = XLSX.utils.aoa_to_sheet([
    ['Período', `${report.period.startDate} a ${report.period.endDate}`],
    ['Fuso do expediente', report.timezone],
    ['Blocos aguardando resposta', waiting],
    ['Blocos encerrados sem resposta', closed],
    ['Conversas com bloco sem resposta', conversations],
  ]);
  unanswered['!cols'] = [{ wch: 34 }, { wch: 26 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, ranking, 'Ranking');
  XLSX.utils.book_append_sheet(workbook, daily, 'Por dia');
  XLSX.utils.book_append_sheet(workbook, unanswered, 'Sem resposta');
  XLSX.writeFile(workbook, responseTimeFileName(report));
}
