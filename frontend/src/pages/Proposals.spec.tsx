import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ListProposalsQuery, ListProposalsResponse, Proposal } from '@crm-lab/shared';
import { queryClient } from '@/api/query-client';
import { querySuccess } from '@/test/query-mocks';
import * as proposalsApi from '@/api/proposals';
import Proposals from './Proposals';

vi.mock('@/api/proposals', () => ({
  useProposalList: vi.fn(),
}));

const useProposalList = vi.mocked(proposalsApi.useProposalList);

/**
 * Duas propostas em paginas diferentes. Sem isto o mock devolveria a mesma
 * carga em qualquer pagina: o encanamento URL -> query ficaria provado, mas
 * "a pagina 2 mostra registro que a 1 nao mostra" — que E a pendencia D7 —
 * nao. Padrao de `Patients/Profile.spec.tsx`.
 */
function proposta(id: string, patientName: string): Proposal {
  return {
    id,
    conversationId: 'conv-1',
    patientName,
    status: 'negociacao',
    discountPercent: 0,
    totalPrice: 100,
    createdBy: 'user-1',
    createdByName: 'Ana Atendente',
    approvalStatus: 'none',
    reasonLost: null,
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
    closedAt: null,
    insuranceId: null,
  };
}

const PAGINA_1 = proposta('11111111-1111-4111-8111-111111111111', 'Rafael da Pagina 1');
const PAGINA_2 = proposta('22222222-2222-4222-8222-222222222222', 'Juliana da Pagina 2');

function listResult(overrides: Partial<ListProposalsResponse> = {}) {
  return querySuccess<ListProposalsResponse>({
    proposals: [],
    pagination: { page: 1, limit: 20, total: 45, totalPages: 3 },
    ...overrides,
  });
}

function renderPage(initialEntry = '/proposals') {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Proposals />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Proposals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProposalList.mockImplementation((query?: ListProposalsQuery) =>
      listResult({
        proposals: query?.page === 2 ? [PAGINA_2] : [PAGINA_1],
        pagination: { page: query?.page ?? 1, limit: 20, total: 45, totalPages: 3 },
      }),
    );
  });

  /**
   * Por CABECALHO (`h3`), nao por texto solto: o mesmo rotulo aparece no chip
   * de status dentro do cartao, e `getByText` casaria os dois.
   */
  it('renders 6 stage columns', () => {
    renderPage();

    for (const titulo of [
      'Novo contato',
      'Orçamento enviado',
      'Follow-up',
      'Negociação',
      'Ganho',
      'Perdido',
    ]) {
      expect(screen.getByRole('heading', { name: titulo })).toBeInTheDocument();
    }
  });

  /**
   * D7 da Onda 5: a tela pedia a página 1 e ignorava `pagination` — proposta
   * antiga era INALCANÇÁVEL pela UI. O que se prova aqui é que a página vem da
   * URL e chega no filtro enviado ao servidor.
   */
  it('pede ao servidor a página que está na URL', () => {
    renderPage('/proposals?page=3');

    const query: ListProposalsQuery = useProposalList.mock.calls.at(-1)?.[0] ?? {};
    expect(query.page).toBe(3);
    expect(query.limit).toBe(20);
  });

  it('trata ?page inválido como página 1', () => {
    renderPage('/proposals?page=abc');

    expect(useProposalList.mock.calls.at(-1)?.[0]?.page).toBe(1);
  });

  it('avança de página pelo controle de paginação e TROCA o conteúdo exibido', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage('/proposals?page=1');

    expect(screen.getByText('Rafael da Pagina 1')).toBeInTheDocument();
    expect(screen.queryByText('Juliana da Pagina 2')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Próxima' }));

    expect(useProposalList.mock.calls.at(-1)?.[0]?.page).toBe(2);
    // O cartao que so existe na pagina 2 entrou; o da pagina 1 saiu.
    expect(await screen.findByText('Juliana da Pagina 2')).toBeInTheDocument();
    expect(screen.queryByText('Rafael da Pagina 1')).not.toBeInTheDocument();
  });

  /**
   * A metade "compartilhavel / sobrevive ao F5" da D7: `?page=2` direto na URL
   * tem de ABRIR na pagina 2 — com o registro da pagina 2 na tela, nao so com
   * o numero certo no filtro.
   */
  it('`?page=2` na URL já abre com o registro da página 2', () => {
    renderPage('/proposals?page=2');

    expect(screen.getByText('Juliana da Pagina 2')).toBeInTheDocument();
    expect(screen.queryByText('Rafael da Pagina 1')).not.toBeInTheDocument();
  });

  it('não mostra paginação quando cabe tudo em uma página', () => {
    useProposalList.mockReturnValue(
      listResult({ pagination: { page: 1, limit: 20, total: 4, totalPages: 1 } }),
    );

    renderPage();

    expect(screen.queryByRole('button', { name: 'Próxima' })).not.toBeInTheDocument();
  });
});
