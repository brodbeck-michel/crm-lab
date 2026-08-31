import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Exam, ListExamsQuery, ListExamsResponse, UserRole } from '@crm-lab/shared';
import { queryClient } from '@/api/query-client';
import { querySuccess, mutationIdle } from '@/test/query-mocks';
import { useAuthStore } from '@/stores/auth.store';
import { DEFAULT_THEME } from '@/lib/theme';
import * as examsApi from '@/api/exams';
import Catalog from './Catalog';

const mockExams: Exam[] = [
  {
    id: 'exam1',
    name: 'Hemograma',
    code: 'HEM001',
    description: null,
    preparation: 'Jejum de 8h',
    turnaroundHours: 24,
    pricePrivate: 50.0,
    priceInsurance: 40.0,
    category: 'Hematologia',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tussCode: '40304361',
    ambCode: null,
    material: 'Sangue — tubo tampa roxa (EDTA)',
    source: 'manual',
    synonyms: ['sangue completo'],
  },
];

/**
 * A pagina 2 traz OUTRO exame. Sem isto o mock devolveria a mesma carga em
 * qualquer pagina e "a tela avancou de pagina" seria provado so pelo numero
 * enviado ao servidor — nunca pelo conteudo que o usuario ve trocar.
 */
const examesPagina2: Exam[] = [
  { ...(mockExams[0] as Exam), id: 'exam2', name: 'Glicose', code: 'GLI002' },
];

vi.mock('@/api/exams', () => ({
  useExamList: vi.fn(),
  useCreateExam: vi.fn(),
  useUpdateExam: vi.fn(),
}));

const useExamList = vi.mocked(examsApi.useExamList);

function listResult(overrides: Partial<ListExamsResponse> = {}) {
  return querySuccess<ListExamsResponse>({
    exams: mockExams,
    pagination: { page: 1, limit: 20, total: 45, totalPages: 3 },
    ...overrides,
  });
}

function signIn(role: UserRole) {
  useAuthStore.setState({
    user: {
      id: 'user1',
      email: 'test@test.com',
      name: 'Test',
      role,
      discountLimit: role === 'attendant' ? 5 : 10,
    },
    tenant: {
      id: 'tenant1',
      name: 'Test Tenant',
      slug: 'test-tenant',
      theme: DEFAULT_THEME,
    },
  });
}

function renderPage(initialEntry = '/catalog') {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Catalog />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    // Carga POR PAGINA (padrao de `Patients/Profile.spec.tsx`): o servidor
    // devolve conjuntos diferentes, e a tela tem de mostrar o da pagina pedida.
    useExamList.mockImplementation((query?: ListExamsQuery) =>
      listResult({
        exams: query?.page === 2 ? examesPagina2 : mockExams,
        pagination: { page: query?.page ?? 1, limit: 20, total: 45, totalPages: 3 },
      }),
    );
    vi.mocked(examsApi.useCreateExam).mockReturnValue(mutationIdle());
    vi.mocked(examsApi.useUpdateExam).mockReturnValue(mutationIdle());
    signIn('attendant');
  });

  it('renders exam table with column headers', () => {
    renderPage();

    expect(screen.getByText(/Catálogo de Exames/i)).toBeInTheDocument();
    expect(screen.getByText(/Nome/i)).toBeInTheDocument();
    expect(screen.getByText(/Código/i)).toBeInTheDocument();
  });

  it('shows create button for non-attendant roles', () => {
    signIn('manager');
    renderPage();

    expect(screen.getByRole('button', { name: /novo exame/i })).toBeInTheDocument();
  });

  it('does not show create button for attendant role', () => {
    renderPage();

    expect(screen.queryByRole('button', { name: /novo exame/i })).not.toBeInTheDocument();
  });

  /**
   * D7 da Onda 5: a tela pedia `limit: 20` sem `page` e ignorava `pagination` —
   * do 21º exame em diante o catálogo era INALCANÇÁVEL pela UI.
   */
  it('pede ao servidor a página que está na URL', () => {
    renderPage('/catalog?page=2');

    const query = useExamList.mock.calls.at(-1)?.[0];
    expect(query?.page).toBe(2);
    expect(query?.limit).toBe(20);
  });

  it('trata ?page inválido como página 1', () => {
    renderPage('/catalog?page=-4');

    expect(useExamList.mock.calls.at(-1)?.[0]?.page).toBe(1);
  });

  it('avança de página pelo controle de paginação e TROCA o conteúdo exibido', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage();

    expect(screen.getByText('45 exames · página 1 de 3')).toBeInTheDocument();
    // Pagina 1: o exame da pagina 1, e nada da pagina 2.
    expect(screen.getByRole('cell', { name: 'Hemograma' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Glicose' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Próxima' }));

    expect(useExamList.mock.calls.at(-1)?.[0]?.page).toBe(2);
    // O que o usuario ve mudou: a linha da pagina 2 entrou e a da 1 saiu.
    expect(await screen.findByRole('cell', { name: 'Glicose' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Hemograma' })).not.toBeInTheDocument();
    expect(screen.getByText('45 exames · página 2 de 3')).toBeInTheDocument();
  });

  /**
   * Buscar troca o CONJUNTO de resultados: "pagina 2 do catalogo inteiro" nao
   * existe dentro do filtro novo, e ficar nela mostraria uma pagina vazia sem
   * explicacao. `Catalog.tsx` responde com `goToPage(1)` no `handleSearch`;
   * ate a Onda 6 nada provava isso — nem aqui nem no E2E.
   */
  it('buscar reinicia a paginação: volta para a página 1 levando o termo', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage('/catalog?page=2');

    expect(useExamList.mock.calls.at(-1)?.[0]?.page).toBe(2);

    await user.type(screen.getByRole('searchbox'), 'glic');

    // O debounce de 300ms do `SearchInput` roda com timers reais aqui.
    await waitFor(() => {
      expect(useExamList.mock.calls.at(-1)?.[0]?.search).toBe('glic');
    });
    expect(useExamList.mock.calls.at(-1)?.[0]?.page).toBe(1);
  });

  /**
   * O `SearchInput` emitia um `onSearch('')` fantasma 300ms depois da montagem
   * (o guard `isFirstRun` não sobrevivia à dupla invocação de efeito do
   * `StrictMode`), e o `handleSearch` daqui responde com `goToPage(1)`: a tela
   * abria em `?page=2` e voltava sozinha para a página 1.
   *
   * O `StrictMode` explícito é o ponto do teste — `render` não o aplica
   * sozinho, então sem ele a suíte ficaria verde com o defeito em pé.
   */
  it('permanece na página da URL depois do debounce, mesmo sob StrictMode', () => {
    vi.useFakeTimers();
    try {
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/catalog?page=2']}>
            <StrictMode>
              <Catalog />
            </StrictMode>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      expect(useExamList.mock.calls.at(-1)?.[0]?.page).toBe(2);

      // Passa MUITO do debounce de 300ms sem nenhuma interação do usuário.
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(useExamList.mock.calls.at(-1)?.[0]?.page).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tabela mostra coluna TUSS e material', () => {
    renderPage();

    expect(screen.getByText('40304361')).toBeInTheDocument();
    expect(screen.getByText(/tubo tampa roxa/i)).toBeInTheDocument();
  });

  it('não mostra paginação quando cabe tudo em uma página', () => {
    useExamList.mockReturnValue(
      listResult({ pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } }),
    );

    renderPage();

    expect(screen.queryByRole('button', { name: 'Próxima' })).not.toBeInTheDocument();
  });
});
