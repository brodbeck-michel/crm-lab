import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryClient } from '@/api/query-client';
import { useAuthStore } from '@/stores/auth.store';
import { DEFAULT_THEME } from '@/lib/theme';
import ThemeSettings from './Theme';

const mockTheme = {
  accent: '#c67139',
  accent2: '#7a8a5e',
  bg: '#f5ead8',
  surface: '#ebddc5',
  text: '#1a1a1a',
  fontId: 'figtree' as const,
  radiusId: 'suave' as const,
  brandName: null,
  logoUrl: null,
};

const mockPresets = [
  {
    id: 'terracota',
    name: 'Terracota & Sálvia',
    accent: '#c67139',
    accent2: '#7a8a5e',
    bg: '#f5ead8',
    surface: '#ebddc5',
    text: '#1a1a1a',
  },
  {
    id: 'jaleco',
    name: 'Jaleco Azul',
    accent: '#2f6f9f',
    accent2: '#4f9d8b',
    bg: '#eef3f7',
    surface: '#dbe6ef',
    text: '#1a1a1a',
  },
  {
    id: 'esteril',
    name: 'Estéril Cinza',
    accent: '#6b7280',
    accent2: '#9ca3af',
    bg: '#f3f4f6',
    surface: '#e5e7eb',
    text: '#1a1a1a',
  },
  {
    id: 'hemograma',
    name: 'Hemograma Carmesim',
    accent: '#b91c1c',
    accent2: '#dc2626',
    bg: '#fef2f2',
    surface: '#fee2e2',
    text: '#1a1a1a',
  },
  {
    id: 'diagnostico',
    name: 'Diagnóstico Verde',
    accent: '#15803d',
    accent2: '#22c55e',
    bg: '#f0fdf4',
    surface: '#dcfce7',
    text: '#1a1a1a',
  },
];

vi.mock('@/api/themes', () => ({
  useThemeCurrent: vi.fn(() => ({
    data: mockTheme,
    isLoading: false,
    error: null,
  })),
  useThemePresets: vi.fn(() => ({
    data: mockPresets,
    isLoading: false,
    error: null,
  })),
  useUpdateTheme: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));

describe('ThemeSettings', () => {
  beforeEach(() => {
    queryClient.clear();
    useAuthStore.setState({
      user: {
        id: 'user1',
        email: 'test@test.com',
        name: 'Test Admin',
        role: 'admin',
        discountLimit: 100,
      },
      tenant: {
        id: 'tenant1',
        name: 'Test Tenant',
        slug: 'test-tenant',
        theme: DEFAULT_THEME,
      },
    });
  });

  it('renders theme settings page with title', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ThemeSettings />
        </BrowserRouter>
      </QueryClientProvider>
    );

    expect(screen.getByText(/Personalização/i)).toBeInTheDocument();
    expect(screen.getByText(/Customize as cores/i)).toBeInTheDocument();
  });

  it('renders 5 preset buttons', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ThemeSettings />
        </BrowserRouter>
      </QueryClientProvider>
    );

    expect(screen.getByText(/Terracota/i)).toBeInTheDocument();
    expect(screen.getByText(/Jaleco/i)).toBeInTheDocument();
    expect(screen.getByText(/Estéril/i)).toBeInTheDocument();
    expect(screen.getByText(/Hemograma/i)).toBeInTheDocument();
    expect(screen.getByText(/Diagnóstico/i)).toBeInTheDocument();
  });

  it('renders color picker', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ThemeSettings />
        </BrowserRouter>
      </QueryClientProvider>
    );

    expect(screen.getByText(/Cor Personalizada/i)).toBeInTheDocument();
  });

  it('renders preview section', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ThemeSettings />
        </BrowserRouter>
      </QueryClientProvider>
    );

    expect(screen.getByText(/Preview/i)).toBeInTheDocument();
  });
});
