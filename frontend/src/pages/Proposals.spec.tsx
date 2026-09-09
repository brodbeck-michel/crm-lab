import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ListProposalsQuery, ListProposalsResponse, Proposal } from '@crm-lab/shared';
import { queryClient } from '@/api/query-client';
import { ToastProvider } from '@/components/ui';
import { querySuccess } from '@/test/query-mocks';
import * as proposalsApi from '@/api/proposals';
import { useUIStore } from '@/stores/ui.store';
import Proposals from './Proposals';

/**
 * `...importOriginal` em vez de um objeto so com `useProposalList`: a tela
 * agora monta o `NewAttendanceModal`, que puxa `useApiErrorHandler` -> barrel
 * `@/api` -> `proposalsApi`. Uma fabrica parcial deixa esse re-export
 * indefinido e o modulo nem carrega.
 */
vi.mock('@/api/proposals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/proposals')>()),
  useProposalList: vi.fn(),
  useUpdateProposalStatus: vi.fn(),
}));

const useProposalList = vi.mocked(proposalsApi.useProposalList);
const useUpdateProposalStatus = vi.mocked(proposalsApi.useUpdateProposalStatus);
const mutate = vi.fn();

/**
 * Duas propostas em paginas diferentes. Sem isto o mock devolveria a mesma
 * carga em qualquer pagina: o encanamento URL -> query ficaria provado, mas
 * "a pagina 2 mostra registro que a 1 nao mostra" — que E a pendencia D7 —
 * nao. Padrao de `Patients/Profile.spec.tsx`.
 */
let proposalNumberSeq = 0;

function proposta(id: string, patientName: string): Proposal {
  proposalNumberSeq += 1;
  return {
    id,
    proposalNumber: proposalNumberSeq,
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
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Proposals />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/**
 * `DataTransfer` nao existe no jsdom, e o dublê aqui precisa reproduzir a regra
 * que o navegador de verdade aplica: durante o `dragover` o drag data store
 * esta em MODO PROTEGIDO — so `types` e legivel, `getData()` devolve `''`.
 *
 * A primeira versao deste helper era um `Map` puro, que devolvia o payload em
 * qualquer fase. Com ele o teste passava e o recurso nao funcionava no
 * navegador: a coluna decidia pelo `getData()` no `dragover`, sempre recebia
 * vazio, nunca chamava `preventDefault()` e o `drop` nem chegava a disparar.
 * Sem o modo protegido aqui, o teste mente de novo.
 */
function dragCard(card: HTMLElement, coluna: HTMLElement) {
  const store = new Map<string, string>();
  let protectedMode = false;
  const dataTransfer = {
    get types() {
      return [...store.keys()];
    },
    setData: (type: string, value: string) => store.set(type.toLowerCase(), value),
    getData: (type: string) => (protectedMode ? '' : (store.get(type.toLowerCase()) ?? '')),
    effectAllowed: 'none',
  };
  fireEvent.dragStart(card, { dataTransfer });
  protectedMode = true;
  fireEvent.dragOver(coluna, { dataTransfer });
  protectedMode = false;
  fireEvent.drop(coluna, { dataTransfer });
}

/** A coluna e o ancestral do cabecalho do estagio. */
function colunaDe(titulo: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: titulo });
  const coluna = heading.parentElement?.parentElement;
  if (!coluna) throw new Error(`coluna ${titulo} nao encontrada`);
  return coluna;
}

describe('Proposals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUpdateProposalStatus.mockReturnValue({ mutate } as unknown as ReturnType<
      typeof proposalsApi.useUpdateProposalStatus
    >);
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
    renderPage('/proposals?view=lista&page=3');

    const query: ListProposalsQuery = useProposalList.mock.calls.at(-1)?.[0] ?? {};
    expect(query.page).toBe(3);
    expect(query.limit).toBe(20);
  });

  it('trata ?page inválido como página 1', () => {
    renderPage('/proposals?view=lista&page=abc');

    expect(useProposalList.mock.calls.at(-1)?.[0]?.page).toBe(1);
  });

  it('avança de página pelo controle de paginação e TROCA o conteúdo exibido', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage('/proposals?view=lista&page=1');

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
  it('`?page=2` na URL já abre com o registro da página 2 (visão lista)', () => {
    renderPage('/proposals?view=lista&page=2');

    expect(screen.getByText('Juliana da Pagina 2')).toBeInTheDocument();
    expect(screen.queryByText('Rafael da Pagina 1')).not.toBeInTheDocument();
  });

  it('o kanban pede o lote inteiro de uma vez, sem paginação', () => {
    renderPage();

    const query: ListProposalsQuery = useProposalList.mock.calls.at(-1)?.[0] ?? {};
    expect(query.limit).toBe(100);
    expect(query.page).toBe(1);
    expect(screen.queryByRole('button', { name: 'Próxima' })).not.toBeInTheDocument();
  });

  it('o toggle troca para a lista e volta, e a lista pagina de 20 em 20', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();

    await user.click(screen.getByRole('tab', { name: 'Lista' }));

    expect(useProposalList.mock.calls.at(-1)?.[0]?.limit).toBe(20);
    // Sem colunas de estagio: a lista e uma grade unica de cartoes.
    expect(screen.queryByRole('heading', { name: 'Negociação' })).not.toBeInTheDocument();
    expect(screen.getByText('Rafael da Pagina 1')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Kanban' }));

    expect(screen.getByRole('heading', { name: 'Negociação' })).toBeInTheDocument();
  });

  it('a busca por nome vai para o servidor como `search`', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByRole('searchbox', { name: 'Buscar paciente' }), 'Rafa');

    await vi.waitFor(() =>
      expect(useProposalList.mock.calls.at(-1)?.[0]?.search).toBe('Rafa'),
    );
  });

  it('arrastar o card para um estágio permitido dispara a transição', () => {
    renderPage();

    dragCard(screen.getByText('Rafael da Pagina 1'), colunaDe('Ganho'));

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: PAGINA_1.id, status: 'ganho' }),
      expect.anything(),
    );
  });

  /** `negociacao` -> `novo_contato` nao esta em ALLOWED_TRANSITIONS. */
  it('arrastar para um estágio proibido não dispara nada', () => {
    renderPage();

    dragCard(screen.getByText('Rafael da Pagina 1'), colunaDe('Novo contato'));

    expect(mutate).not.toHaveBeenCalled();
  });

  /** `perdido` exige `reasonLost`: o drop abre a proposta em vez de mutar. */
  it('arrastar para Perdido abre a proposta em vez de mudar o estágio direto', () => {
    renderPage();

    dragCard(screen.getByText('Rafael da Pagina 1'), colunaDe('Perdido'));

    expect(mutate).not.toHaveBeenCalled();
    expect(useUIStore.getState().activeModal).toEqual({ kind: 'proposal', id: PAGINA_1.id });
  });

  it('não mostra paginação quando cabe tudo em uma página', () => {
    useProposalList.mockReturnValue(
      listResult({ pagination: { page: 1, limit: 20, total: 4, totalPages: 1 } }),
    );

    renderPage('/proposals?view=lista');

    expect(screen.queryByRole('button', { name: 'Próxima' })).not.toBeInTheDocument();
  });
});
