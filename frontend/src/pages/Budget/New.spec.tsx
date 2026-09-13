import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { DEFAULT_THEME } from '@/lib/theme';
import { QueryClient } from '@tanstack/react-query';
import BudgetNew from './New';
import SummaryColumn from '@/components/budget/SummaryColumn';
import { ToastProvider } from '@/components/ui';
import { http } from '@/api/client';
import type { QueryParams } from '@/api/client';

/**
 * O convênio "Unimed Tubarão" devolvido por `GET /insurances` — usado pelo
 * seletor de convênio (`InsuranceSelector`, Task 8) e pelas asserções de
 * `insuranceId` enviado ao backend.
 */
const UNIMED_ID = '11111111-1111-4111-8111-111111111111';

const HEMOGRAMA = {
  id: 'exam-1',
  name: 'Hemograma',
  code: 'HEM',
  description: null,
  preparation: null,
  turnaroundHours: null,
  pricePrivate: 50,
  priceInsurance: 40,
  category: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  tussCode: null,
  ambCode: null,
  material: null,
  source: 'manual' as const,
  synonyms: [] as string[],
};

// Mock the API calls. Roteado por path — cobre `/exams`, `/insurances` e
// `/proposals`, os três recursos que `BudgetNew` consome (direto ou via
// `CatalogSegments`/`SummaryColumn`/`InsuranceSelector`).
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual('@/api/client');
  return {
    ...actual,
    http: {
      get: vi.fn((path: string, query?: QueryParams) => {
        if (path === '/insurances') {
          return Promise.resolve({
            insurances: [
              {
                id: UNIMED_ID,
                name: 'Unimed Tubarão',
                officialName: null,
                ansCode: '364860',
                type: 'cooperativa',
                isActive: true,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
            pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
          });
        }

        if (path === '/exams') {
          const insuranceId = query?.insuranceId as string | undefined;
          return Promise.resolve({
            exams: [
              insuranceId
                ? { ...HEMOGRAMA, effectivePrice: 35, priceSource: 'insurance' as const }
                : HEMOGRAMA,
            ],
            pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
          });
        }

        // Shape de `ListExamsResponse` — `pagination` é `PaginationMeta`
        // (`page/limit/total/totalPages`), não `offset`.
        return Promise.resolve({
          exams: [],
          pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
        });
      }),
      post: vi.fn((path: string, body?: unknown) => {
        if (path === '/proposals') {
          const insuranceId = (body as { insuranceId?: string | null } | undefined)?.insuranceId;
          return Promise.resolve({
            id: '1',
            status: 'novo_contato',
            approvalStatus: 'none',
            totalPrice: 0,
            insuranceId: insuranceId ?? null,
          });
        }
        return Promise.resolve({});
      }),
      patch: vi.fn(() => Promise.resolve({})),
      put: vi.fn(() => Promise.resolve({})),
      delete: vi.fn(() => Promise.resolve({})),
    },
  };
});

// Create a fresh query client for each test
let queryClient: QueryClient;

describe('BudgetNew', () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    useAuthStore.setState({
      user: {
        id: 'user1',
        email: 'atendente@lab.com',
        discountLimit: 10,
        role: 'attendant',
        name: 'Test User',
      },
      tenant: { id: 'tenant1', name: 'Test Tenant', slug: 'test-tenant', theme: DEFAULT_THEME },
      theme: null,
      tokens: null,
    });
  });

  it('renders 2 columns: catalog and summary', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <BrowserRouter>
            <BudgetNew />
          </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /catálogo/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /resumo/i })).toBeInTheDocument();
    });
  });

  it('displays budget layout sections', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <BrowserRouter>
            <BudgetNew />
          </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      const layout = screen.getByTestId('budget-layout');
      expect(layout).toBeInTheDocument();

      const catalog = screen.getByTestId('budget-catalog');
      const summary = screen.getByTestId('budget-summary');
      expect(catalog).toBeInTheDocument();
      expect(summary).toBeInTheDocument();
    });
  });

  it('seletor de convênio nasce em Particular e refaz a busca ao trocar', async () => {
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <BrowserRouter>
            <BudgetNew />
          </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    );

    const select = await screen.findByRole('combobox', { name: /convênio/i });
    // Native <select>: o textContent inclui o texto de TODAS as <option>,
    // não só a selecionada — por isso o valor também é conferido abaixo.
    expect(select).toHaveTextContent('Particular');
    expect(select).toHaveValue('');

    // `useInsuranceList` ainda está buscando `/insurances` — só "Particular"
    // existe até a resposta chegar.
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Unimed Tubarão' })).toBeInTheDocument();
    });

    await user.selectOptions(select, 'Unimed Tubarão');

    await waitFor(() => {
      expect(vi.mocked(http.get)).toHaveBeenCalledWith(
        '/exams',
        expect.objectContaining({ insuranceId: expect.any(String) })
      );
    });
  });

  it('item com priceSource private numa proposta com convênio mostra badge "particular"', async () => {
    const items = [
      {
        examId: 'exam-1',
        examName: 'Hemograma',
        unitPrice: 50,
        quantity: 1,
        priceSource: 'private' as const,
      },
    ];

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter>
            <SummaryColumn
              conversationId="conv-1"
              items={items}
              insuranceId={UNIMED_ID}
              onRemoveItem={() => {}}
            />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    );

    // Convênio selecionado + item cujo preço veio da tabela particular
    // (fallback) — a exceção precisa ficar visível.
    expect(await screen.findByTestId('price-source-badge')).toBeInTheDocument();

    // insuranceId null (particular): TODO item já é particular — o badge
    // seria redundante e não deve aparecer.
    rerender(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter>
            <SummaryColumn
              conversationId="conv-1"
              items={items}
              insuranceId={null}
              onRemoveItem={() => {}}
            />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    );

    expect(screen.queryByTestId('price-source-badge')).not.toBeInTheDocument();
  });

  it('POST /proposals envia insuranceId escolhido', async () => {
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/budget/new?conversationId=conv-77']}>
            <BudgetNew />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    );

    const select = await screen.findByRole('combobox', { name: /convênio/i });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Unimed Tubarão' })).toBeInTheDocument();
    });
    await user.selectOptions(select, 'Unimed Tubarão');

    const examButton = await screen.findByRole('button', { name: /hemograma/i });
    await user.click(examButton);

    const submitButton = await screen.findByRole('button', { name: /criar orçamento/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(vi.mocked(http.post)).toHaveBeenCalledWith(
        '/proposals',
        expect.objectContaining({ insuranceId: UNIMED_ID })
      );
    });
  });

  // CRMLAB-9: campo de texto livre, opcional, sem cadastro/autocomplete de médicos.
  it('sem médico solicitante preenchido, envia requestingDoctor: null', async () => {
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/budget/new?conversationId=conv-77']}>
            <BudgetNew />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    );

    const examButton = await screen.findByRole('button', { name: /hemograma/i });
    await user.click(examButton);

    const submitButton = await screen.findByRole('button', { name: /criar orçamento/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(vi.mocked(http.post)).toHaveBeenCalledWith(
        '/proposals',
        expect.objectContaining({ requestingDoctor: null })
      );
    });
  });

  it('com médico solicitante preenchido, envia o texto digitado', async () => {
    const user = userEvent.setup();

    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/budget/new?conversationId=conv-77']}>
            <BudgetNew />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    );

    const examButton = await screen.findByRole('button', { name: /hemograma/i });
    await user.click(examButton);

    const doctorInput = screen.getByLabelText(/médico solicitante/i);
    await user.type(doctorInput, 'Dra. Ana Souza');

    const submitButton = await screen.findByRole('button', { name: /criar orçamento/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(vi.mocked(http.post)).toHaveBeenCalledWith(
        '/proposals',
        expect.objectContaining({ requestingDoctor: 'Dra. Ana Souza' })
      );
    });
  });
});
