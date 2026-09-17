import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ListExamPackagePricesResponse, ListInsurancesResponse } from '@crm-lab/shared';
import { querySuccess, mutationIdle } from '@/test/query-mocks';
import PackagePricesTab from './PackagePricesTab';
import * as insurancesApi from '@/api/insurances';
import * as examPackagesApi from '@/api/exam-packages';

vi.mock('@/api/insurances', async () => {
  const actual = await vi.importActual('@/api/insurances');
  return { ...actual, useInsuranceList: vi.fn() };
});

vi.mock('@/api/exam-packages', async () => {
  const actual = await vi.importActual('@/api/exam-packages');
  return { ...actual, useExamPackagePrices: vi.fn(), useUpdateExamPackagePrices: vi.fn() };
});

const useInsuranceList = vi.mocked(insurancesApi.useInsuranceList);
const useExamPackagePrices = vi.mocked(examPackagesApi.useExamPackagePrices);
const useUpdateExamPackagePrices = vi.mocked(examPackagesApi.useUpdateExamPackagePrices);

const insurances: ListInsurancesResponse = {
  insurances: [
    {
      id: 'ins-1',
      name: 'Unimed Tubarão',
      officialName: null,
      ansCode: '364860',
      type: 'cooperativa',
      isActive: true,
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'ins-2',
      name: 'Bradesco Saúde',
      officialName: null,
      ansCode: null,
      type: 'seguradora',
      isActive: true,
      createdAt: '',
      updatedAt: '',
    },
  ],
  pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
};

/**
 * `PUT /exam-packages/:id/prices` é semântica de PUT — mesmo contrato de
 * `ExamPricesTab` (§4/§4b): grid começa com o preço ATUAL de cada convênio, e
 * salvar só envia linhas preenchidas — em branco é REMOVIDO, não preservado.
 */
describe('PackagePricesTab', () => {
  const mockMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useInsuranceList.mockReturnValue(querySuccess<ListInsurancesResponse>(insurances));
    useExamPackagePrices.mockReturnValue(
      querySuccess<ListExamPackagePricesResponse>({ prices: [{ insuranceId: 'ins-1', price: 99.9 }] }),
    );
    useUpdateExamPackagePrices.mockReturnValue(mutationIdle(mockMutate));
  });

  it('preenche o grid com o preço atual de cada convênio, e vazio quando não há preço', () => {
    render(<PackagePricesTab packageId="pkg-1" canEdit />);

    expect(screen.getByLabelText('Preço — Unimed Tubarão')).toHaveValue(99.9);
    expect(screen.getByLabelText('Preço — Bradesco Saúde')).toHaveValue(null);
  });

  it('salvar envia só as linhas preenchidas — em branco é removido, não preservado', async () => {
    const user = userEvent.setup();
    render(<PackagePricesTab packageId="pkg-1" canEdit />);

    await user.type(screen.getByLabelText('Preço — Bradesco Saúde'), '85.00');
    await user.click(screen.getByRole('button', { name: /salvar preços/i }));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    const call = mockMutate.mock.calls[0]?.[0];
    expect(call.id).toBe('pkg-1');
    expect(call.data.prices).toEqual(
      expect.arrayContaining([
        { insuranceId: 'ins-1', price: 99.9 },
        { insuranceId: 'ins-2', price: 85 },
      ]),
    );
    expect(call.data.prices).toHaveLength(2);
  });

  it('limpar o campo de um convênio com preço e salvar REMOVE a linha (não envia)', async () => {
    const user = userEvent.setup();
    render(<PackagePricesTab packageId="pkg-1" canEdit />);

    await user.clear(screen.getByLabelText('Preço — Unimed Tubarão'));
    await user.click(screen.getByRole('button', { name: /salvar preços/i }));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate.mock.calls[0]?.[0]?.data.prices).toEqual([]);
  });

  it('sem permissão de escrita, não mostra o botão de salvar', () => {
    render(<PackagePricesTab packageId="pkg-1" canEdit={false} />);

    expect(screen.queryByRole('button', { name: /salvar preços/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Preço — Unimed Tubarão')).toBeDisabled();
  });
});
