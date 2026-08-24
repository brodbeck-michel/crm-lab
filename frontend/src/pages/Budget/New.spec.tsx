import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { QueryClient } from '@tanstack/react-query';
import BudgetNew from './New';

// Mock the API calls
vi.mock('@/api/client', async () => {
  const actual = await vi.importActual('@/api/client');
  return {
    ...actual,
    http: {
      get: vi.fn(() =>
        Promise.resolve({ exams: [], pagination: { total: 0, limit: 50, offset: 0 } })
      ),
      post: vi.fn(() =>
        Promise.resolve({
          id: '1',
          status: 'novo_contato',
          approvalStatus: 'none',
          totalPrice: 0,
        })
      ),
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
      user: { id: 'user1', discountLimit: 10, role: 'attendant', name: 'Test User' },
      tenant: { id: 'tenant1', name: 'Test Tenant' },
      theme: null,
      tokens: null,
    } as any);
  });

  it('renders 2 columns: catalog and summary', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <BudgetNew />
        </BrowserRouter>
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
        <BrowserRouter>
          <BudgetNew />
        </BrowserRouter>
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
});
