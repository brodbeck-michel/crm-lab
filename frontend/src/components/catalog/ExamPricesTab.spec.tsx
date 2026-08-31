import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ListExamPricesResponse, ListInsurancesResponse } from '@crm-lab/shared';
import { querySuccess, mutationIdle } from '@/test/query-mocks';
import ExamPricesTab from './ExamPricesTab';
import * as insurancesApi from '@/api/insurances';
import * as examsApi from '@/api/exams';

vi.mock('@/api/insurances', async () => {
  const actual = await vi.importActual('@/api/insurances');
  return { ...actual, useInsuranceList: vi.fn() };
});

vi.mock('@/api/exams', async () => {
  const actual = await vi.importActual('@/api/exams');
  return { ...actual, useExamPrices: vi.fn(), useUpdateExamPrices: vi.fn() };
});

const useInsuranceList = vi.mocked(insurancesApi.useInsuranceList);
const useExamPrices = vi.mocked(examsApi.useExamPrices);
const useUpdateExamPrices = vi.mocked(examsApi.useUpdateExamPrices);

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
 * `PUT /exams/:id/prices` é semântica de PUT — estado completo (§4/§8): o
 * grid começa com o preço ATUAL de cada convênio (vazio quando não há linha
 * em `exam_prices`), e o salvar só envia as linhas com valor preenchido —
 * linha em branco é REMOVIDA, não preservada.
 */
describe('ExamPricesTab', () => {
  const mockMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useInsuranceList.mockReturnValue(querySuccess<ListInsurancesResponse>(insurances));
    useExamPrices.mockReturnValue(
      querySuccess<ListExamPricesResponse>({ prices: [{ insuranceId: 'ins-1', price: 72.5 }] }),
    );
    useUpdateExamPrices.mockReturnValue(mutationIdle(mockMutate));
  });

  it('preenche o grid com o preço atual de cada convênio, e vazio quando não há preço', () => {
    render(<ExamPricesTab examId="exam-1" canEdit />);

    expect(screen.getByLabelText('Preço — Unimed Tubarão')).toHaveValue(72.5);
    expect(screen.getByLabelText('Preço — Bradesco Saúde')).toHaveValue(null);
  });

  it('salvar envia só as linhas preenchidas — em branco é removido, não preservado', async () => {
    const user = userEvent.setup();
    render(<ExamPricesTab examId="exam-1" canEdit />);

    await user.type(screen.getByLabelText('Preço — Bradesco Saúde'), '55.90');
    await user.click(screen.getByRole('button', { name: /salvar preços/i }));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    const call = mockMutate.mock.calls[0]?.[0];
    expect(call.id).toBe('exam-1');
    expect(call.data.prices).toEqual(
      expect.arrayContaining([
        { insuranceId: 'ins-1', price: 72.5 },
        { insuranceId: 'ins-2', price: 55.9 },
      ]),
    );
    expect(call.data.prices).toHaveLength(2);
  });

  it('limpar o campo de um convênio com preço e salvar REMOVE a linha (não envia)', async () => {
    const user = userEvent.setup();
    render(<ExamPricesTab examId="exam-1" canEdit />);

    await user.clear(screen.getByLabelText('Preço — Unimed Tubarão'));
    await user.click(screen.getByRole('button', { name: /salvar preços/i }));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate.mock.calls[0]?.[0]?.data.prices).toEqual([]);
  });

  it('sem permissão de escrita, não mostra o botão de salvar', () => {
    render(<ExamPricesTab examId="exam-1" canEdit={false} />);

    expect(screen.queryByRole('button', { name: /salvar preços/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Preço — Unimed Tubarão')).toBeDisabled();
  });
});
