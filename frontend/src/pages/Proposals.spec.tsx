import { render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { queryClient } from '@/api/query-client';
import Proposals from './Proposals';

vi.mock('@/api/proposals', () => ({
  useProposalList: vi.fn(() => ({
    data: [],
    isLoading: false,
    error: null,
  })),
}));

describe('Proposals', () => {
  it('renders 6 stage columns', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Proposals />
        </BrowserRouter>
      </QueryClientProvider>
    );

    expect(screen.getByText('Novo contato')).toBeInTheDocument();
    expect(screen.getByText('Orçamento enviado')).toBeInTheDocument();
    expect(screen.getByText('Follow-up')).toBeInTheDocument();
    expect(screen.getByText('Negociação')).toBeInTheDocument();
    expect(screen.getByText('Ganho')).toBeInTheDocument();
    expect(screen.getByText('Perdido')).toBeInTheDocument();
  });
});
