import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { Exam, ListExamsResponse } from '@crm-lab/shared';
import { querySuccess, mutationIdle } from '@/test/query-mocks';
import ExamModal from './ExamModal';
import * as examsApi from '@/api/exams';

vi.mock('@/api/exams', async () => {
  const actual = await vi.importActual('@/api/exams');
  return {
    ...actual,
    useCreateExam: vi.fn(),
    useUpdateExam: vi.fn(),
    useExamList: vi.fn(),
  };
});

/**
 * Defeito QA-E2E #1: o modal varria `useExamList({ limit: 1000 })` para achar o
 * exame. O zod do controller corta em `.max(100)` → `GET /exams?limit=1000`
 * volta 400 → o formulário abre vazio. O exame chega pela linha clicada.
 */
describe('ExamModal', () => {
  const mockOnClose = vi.fn();
  const mockCreateExam = vi.fn();
  const mockUpdateExam = vi.fn();

  const rowExam: Exam = {
    id: 'exam-1',
    name: 'Hemograma Completo',
    code: 'HEM001',
    description: 'Contagem de células',
    preparation: 'Jejum de 8h',
    turnaroundHours: 24,
    pricePrivate: 50,
    priceInsurance: 40,
    category: 'Hematologia',
    isActive: true,
    createdAt: '2026-08-01T10:00:00Z',
    updatedAt: '2026-08-01T10:00:00Z',
    tussCode: '40304361',
    ambCode: null,
    material: 'Sangue — tubo tampa roxa (EDTA)',
    source: 'manual',
    synonyms: ['sangue completo'],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(examsApi.useCreateExam).mockReturnValue(mutationIdle(mockCreateExam));
    vi.mocked(examsApi.useUpdateExam).mockReturnValue(mutationIdle(mockUpdateExam));
    vi.mocked(examsApi.useExamList).mockReturnValue(
      querySuccess<ListExamsResponse>({
        exams: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      }),
    );
  });

  it('abre em modo de criação com os campos vazios', () => {
    render(<ExamModal onClose={mockOnClose} />);

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Novo Exame');
    expect(screen.getByLabelText('Nome')).toHaveValue('');
  });

  it('preenche o formulário com o exame recebido da linha', async () => {
    render(<ExamModal exam={rowExam} onClose={mockOnClose} />);

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Editar Exame');
    await waitFor(() => {
      expect(screen.getByLabelText('Nome')).toHaveValue('Hemograma Completo');
      expect(screen.getByLabelText('Código')).toHaveValue('HEM001');
      expect(screen.getByLabelText('Preço Particular (R$)')).toHaveValue(50);
    });
  });

  it('não lista exames para editar (limit > 100 volta 400)', () => {
    render(<ExamModal exam={rowExam} onClose={mockOnClose} />);

    expect(vi.mocked(examsApi.useExamList)).not.toHaveBeenCalled();
  });

  it('preenche TUSS, AMB e material com o exame recebido', async () => {
    render(<ExamModal exam={rowExam} onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Código TUSS')).toHaveValue('40304361');
      expect(screen.getByLabelText('Código AMB')).toHaveValue('');
      expect(screen.getByLabelText('Material')).toHaveValue('Sangue — tubo tampa roxa (EDTA)');
    });
  });

  it('lista os sinônimos do exame como chips removíveis', async () => {
    render(<ExamModal exam={rowExam} onClose={mockOnClose} />);

    expect(await screen.findByText('sangue completo ×')).toBeInTheDocument();
  });

  it('modal do exame tem aba "Preços por convênio" em modo edição', () => {
    render(<ExamModal exam={rowExam} onClose={mockOnClose} />);

    expect(screen.getByRole('tab', { name: /preços por convênio/i })).toBeInTheDocument();
  });

  it('modo de criação não mostra a aba de preços (não há exame ainda)', () => {
    render(<ExamModal onClose={mockOnClose} />);

    expect(screen.queryByRole('tab', { name: /preços por convênio/i })).not.toBeInTheDocument();
  });
});
