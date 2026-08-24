import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryClient } from '@/api/query-client';
import { useAuthStore } from '@/stores/auth.store';
import { DEFAULT_THEME } from '@/lib/theme';
import Catalog from './Catalog';

const mockExams = [
  {
    id: 'exam1',
    name: 'Hemograma',
    code: 'HEM001',
    description: null,
    preparation: 'Jejum de 8h',
    turnaroundHours: 24,
    pricePrivate: 50.00,
    priceInsurance: 40.00,
    category: 'Hematologia',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

vi.mock('@/api/exams', () => ({
  useExamList: vi.fn(() => ({
    data: mockExams,
    isLoading: false,
    error: null,
  })),
  useCreateExam: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useUpdateExam: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

describe('Catalog', () => {
  beforeEach(() => {
    queryClient.clear();
  });

  it('renders exam table with column headers', () => {
    useAuthStore.setState({
      user: {
        id: 'user1',
        email: 'test@test.com',
        name: 'Test',
        role: 'attendant',
        discountLimit: 5,
      },
      tenant: {
        id: 'tenant1',
        name: 'Test Tenant',
        slug: 'test-tenant',
        theme: DEFAULT_THEME,
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Catalog />
        </BrowserRouter>
      </QueryClientProvider>
    );

    expect(screen.getByText(/Catálogo de Exames/i)).toBeInTheDocument();
    expect(screen.getByText(/Nome/i)).toBeInTheDocument();
    expect(screen.getByText(/Código/i)).toBeInTheDocument();
  });

  it('shows create button for non-attendant roles', () => {
    useAuthStore.setState({
      user: {
        id: 'user1',
        email: 'test@test.com',
        name: 'Test',
        role: 'manager',
        discountLimit: 10,
      },
      tenant: {
        id: 'tenant1',
        name: 'Test Tenant',
        slug: 'test-tenant',
        theme: DEFAULT_THEME,
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Catalog />
        </BrowserRouter>
      </QueryClientProvider>
    );

    expect(screen.getByRole('button', { name: /novo exame/i })).toBeInTheDocument();
  });

  it('does not show create button for attendant role', () => {
    useAuthStore.setState({
      user: {
        id: 'user1',
        email: 'test@test.com',
        name: 'Test',
        role: 'attendant',
        discountLimit: 5,
      },
      tenant: {
        id: 'tenant1',
        name: 'Test Tenant',
        slug: 'test-tenant',
        theme: DEFAULT_THEME,
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Catalog />
        </BrowserRouter>
      </QueryClientProvider>
    );

    expect(screen.queryByRole('button', { name: /novo exame/i })).not.toBeInTheDocument();
  });
});
