import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import StageHistory from './StageHistory';

// CRMLAB-59/D-208 — PAGES.md §6: a linha movida pelo motor de tempo diz a regra.
describe('StageHistory', () => {
  it('linha do motor mostra "movido pela regra", linha de pessoa mostra "por"', () => {
    render(
      <StageHistory
        history={[
          {
            status: 'orcamento_enviado',
            changedAt: '2026-09-21T13:00:00.000Z',
            changedBy: 'user-1',
            changedByName: 'Ana',
            automation: null,
          },
          {
            status: 'follow_up',
            changedAt: '2026-09-24T13:00:00.000Z',
            changedBy: null,
            changedByName: null,
            automation: { rule: 'sentToFollowUp', days: 3, dayCounting: 'calendar' },
          },
        ]}
      />,
    );
    expect(screen.getByText('por Ana')).toBeInTheDocument();
    expect(screen.getByText('movido pela regra: Enviado há 3 dias')).toBeInTheDocument();
  });

  it('linha do sistema sem regra (LIS) não mostra autor nem regra', () => {
    render(
      <StageHistory
        history={[
          { status: 'ganho', changedAt: '2026-09-21T13:00:00.000Z', changedBy: null, changedByName: null },
        ]}
      />,
    );
    expect(screen.queryByText(/movido pela regra/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^por /)).not.toBeInTheDocument();
  });
});
