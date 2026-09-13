import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  Exam,
  ExamPackage,
  ListExamPackagePricesResponse,
  ListExamsResponse,
} from '@crm-lab/shared';
import { querySuccess, mutationIdle } from '@/test/query-mocks';
import PackageModal from './PackageModal';
import * as examsApi from '@/api/exams';
import * as examPackagesApi from '@/api/exam-packages';

vi.mock('@/api/exams', async () => {
  const actual = await vi.importActual('@/api/exams');
  return { ...actual, useExamList: vi.fn() };
});

vi.mock('@/api/exam-packages', async () => {
  const actual = await vi.importActual('@/api/exam-packages');
  return {
    ...actual,
    useCreateExamPackage: vi.fn(),
    useUpdateExamPackage: vi.fn(),
    useExamPackagePrices: vi.fn(),
    useUpdateExamPackagePrices: vi.fn(),
  };
});

const exam1: Exam = {
  id: 'exam-1',
  name: 'Hemograma',
  code: 'HEM001',
  description: null,
  preparation: null,
  turnaroundHours: null,
  pricePrivate: 50,
  priceInsurance: 40,
  category: null,
  isActive: true,
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-01T10:00:00Z',
  tussCode: null,
  ambCode: null,
  material: null,
  source: 'manual',
  synonyms: [],
};

const exam2: Exam = { ...exam1, id: 'exam-2', name: 'Colesterol total', code: 'COL001', pricePrivate: 30 };

const rowPackage: ExamPackage = {
  id: 'pkg-1',
  name: 'Check-up Cardiológico',
  discountPercent: 10,
  items: [
    { examId: 'exam-1', examName: 'Hemograma', examCode: 'HEM001', pricePrivate: 50 },
  ],
  pricePrivate: 45,
  isActive: true,
  createdAt: '2026-09-13T10:00:00Z',
  updatedAt: '2026-09-13T10:00:00Z',
};

describe('PackageModal', () => {
  const mockOnClose = vi.fn();
  const mockCreatePackage = vi.fn();
  const mockUpdatePackage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(examsApi.useExamList).mockReturnValue(
      querySuccess<ListExamsResponse>({
        exams: [exam1, exam2],
        pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
      }),
    );
    vi.mocked(examPackagesApi.useCreateExamPackage).mockReturnValue(mutationIdle(mockCreatePackage));
    vi.mocked(examPackagesApi.useUpdateExamPackage).mockReturnValue(mutationIdle(mockUpdatePackage));
    vi.mocked(examPackagesApi.useExamPackagePrices).mockReturnValue(
      querySuccess<ListExamPackagePricesResponse>({ prices: [] }),
    );
    vi.mocked(examPackagesApi.useUpdateExamPackagePrices).mockReturnValue(mutationIdle());
  });

  it('abre em modo de criação com os campos vazios', () => {
    render(<PackageModal onClose={mockOnClose} />);

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Novo Pacote');
    expect(screen.getByLabelText('Nome')).toHaveValue('');
    expect(screen.getByLabelText('Desconto (%)')).toHaveValue(0);
  });

  it('preenche o formulário com o pacote recebido da linha', () => {
    render(<PackageModal pkg={rowPackage} onClose={mockOnClose} />);

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Editar Pacote');
    expect(screen.getByLabelText('Nome')).toHaveValue('Check-up Cardiológico');
    expect(screen.getByLabelText('Desconto (%)')).toHaveValue(10);
  });

  it('marca os exames já incluídos no pacote como selecionados', () => {
    render(<PackageModal pkg={rowPackage} onClose={mockOnClose} />);

    expect(screen.getByRole('checkbox', { name: /Hemograma/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Colesterol total/ })).not.toBeChecked();
  });

  it('não permite salvar sem nome ou sem nenhum exame selecionado', () => {
    render(<PackageModal onClose={mockOnClose} />);

    expect(screen.getByRole('button', { name: 'Criar' })).toBeDisabled();
  });

  it('cria o pacote com os exames selecionados', async () => {
    const user = userEvent.setup();
    render(<PackageModal onClose={mockOnClose} />);

    await user.type(screen.getByLabelText('Nome'), 'Check-up Básico');
    await user.click(screen.getByRole('checkbox', { name: /Hemograma/ }));
    await user.click(screen.getByRole('button', { name: 'Criar' }));

    expect(mockCreatePackage).toHaveBeenCalledWith({
      name: 'Check-up Básico',
      examIds: ['exam-1'],
      discountPercent: 0,
    });
  });

  it('atualiza o pacote substituindo o conjunto de exames', async () => {
    const user = userEvent.setup();
    render(<PackageModal pkg={rowPackage} onClose={mockOnClose} />);

    await user.click(screen.getByRole('checkbox', { name: /Colesterol total/ }));
    await user.click(screen.getByRole('button', { name: 'Atualizar' }));

    expect(mockUpdatePackage).toHaveBeenCalledWith({
      id: 'pkg-1',
      data: {
        name: 'Check-up Cardiológico',
        examIds: ['exam-1', 'exam-2'],
        discountPercent: 10,
        isActive: true,
      },
    });
  });

  it('modal do pacote tem aba "Preços por convênio" em modo edição', () => {
    render(<PackageModal pkg={rowPackage} onClose={mockOnClose} />);

    expect(screen.getByRole('tab', { name: /preços por convênio/i })).toBeInTheDocument();
  });

  it('modo de criação não mostra a aba de preços (não há pacote ainda)', () => {
    render(<PackageModal onClose={mockOnClose} />);

    expect(screen.queryByRole('tab', { name: /preços por convênio/i })).not.toBeInTheDocument();
  });

  it('mostra prévia do preço particular calculada a partir dos exames selecionados', async () => {
    const user = userEvent.setup();
    render(<PackageModal onClose={mockOnClose} />);

    await user.click(screen.getByRole('checkbox', { name: /Hemograma/ }));
    await user.click(screen.getByRole('checkbox', { name: /Colesterol total/ }));

    await waitFor(() => {
      expect(screen.getByText(/prévia/i)).toBeInTheDocument();
    });
  });
});
