import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PROPOSAL_STATUSES, PROPOSAL_STATUS_LABELS } from '@crm-lab/shared';
import StageColumn from './StageColumn';
import { STAGE_TONES } from './stageTone';

// CRMLAB-91/D-260: cada coluna do pipeline tem a cor do seu estágio.
describe('StageColumn', () => {
  it.each(PROPOSAL_STATUSES)('coluna %s usa o tom do próprio estágio', (status) => {
    const { container } = render(<StageColumn status={status} proposals={[]} />);
    const column = container.firstElementChild;
    expect(column).toHaveAttribute('data-stage', status);
    expect(column).toHaveClass(...STAGE_TONES[status].column.split(' '));
    expect(screen.getByText(PROPOSAL_STATUS_LABELS[status])).toBeInTheDocument();
  });

  it('os seis estágios têm tons diferentes', () => {
    const columns = new Set(PROPOSAL_STATUSES.map((s) => STAGE_TONES[s].column));
    expect(columns.size).toBe(PROPOSAL_STATUSES.length);
  });
});
