import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ProposalDetail, UserRole } from '@crm-lab/shared';
import { conversationsApi } from '@/api/conversations';
import * as proposalsApi from '@/api/proposals';
import { mutationIdle } from '@/test/query-mocks';
import { ToastProvider } from '@/components/ui';
import ResponsibleField from './ResponsibleField';

vi.mock('@/api/conversations');
vi.mock('@/api/proposals');

let mutate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mutate = vi.fn();
  vi.mocked(proposalsApi.useUpdateProposalResponsible).mockReturnValue(mutationIdle(mutate));
  vi.mocked(conversationsApi.assignees).mockResolvedValue({
    assignees: [
      { id: 'u-ana', name: 'Ana', role: 'attendant' },
      { id: 'u-bia', name: 'Bia', role: 'attendant' },
      { id: 'u-gil', name: 'Gil', role: 'manager' },
    ],
  });
});

function proposal(overrides: Partial<ProposalDetail> = {}): ProposalDetail {
  return {
    id: 'prop-1',
    status: 'orcamento_enviado',
    createdBy: 'u-ana',
    createdByName: 'Ana',
    ...overrides,
  } as ProposalDetail;
}

function renderField(p: ProposalDetail, user: { id: string; role: UserRole } | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <ResponsibleField proposal={p} user={user} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function optionsOf(): Promise<string[]> {
  const select = await screen.findByLabelText('Responsável');
  await within(select).findByText('Bia');
  return within(select)
    .getAllByRole('option')
    .map((o) => o.textContent ?? '');
}

describe('ResponsibleField', () => {
  it('gestor escolhe qualquer pessoa ativa e o PATCH sai com o id', async () => {
    renderField(proposal(), { id: 'u-gil', role: 'manager' });
    expect(await optionsOf()).toEqual(['Ana', 'Bia', 'Gil']);
    fireEvent.change(screen.getByLabelText('Responsável'), { target: { value: 'u-bia' } });
    expect(mutate).toHaveBeenCalledWith(
      { proposalId: 'prop-1', body: { userId: 'u-bia' } },
      expect.anything(),
    );
  });

  it('atendente dona só passa para outra atendente', async () => {
    renderField(proposal(), { id: 'u-ana', role: 'attendant' });
    expect(await optionsOf()).toEqual(['Ana', 'Bia']);
  });

  it('atendente que não é dona, ou em proposta fechada, só lê', () => {
    renderField(proposal({ createdBy: null, createdByName: '' }), { id: 'u-ana', role: 'attendant' });
    expect(screen.getByText('Sem responsável (fila comum)')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('atendente dona em proposta ganha só lê; gestor continua editando', () => {
    renderField(proposal({ status: 'ganho' }), { id: 'u-ana', role: 'attendant' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('Ana')).toBeInTheDocument();
  });
});
