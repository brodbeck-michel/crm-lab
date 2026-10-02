import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Exam } from '@crm-lab/shared';
import * as examsApi from '@/api/exams';
import { ExamPicker } from './ExamPicker';
import type { PickedExam } from './ExamPicker';

vi.mock('@/api/exams', async () => {
  const actual = await vi.importActual('@/api/exams');
  return { ...actual, useExamListInfinite: vi.fn() };
});

const useExamListInfinite = vi.mocked(examsApi.useExamListInfinite);

function exam(overrides: Partial<Exam>): Exam {
  return {
    id: 'e-0',
    name: 'Exame',
    code: 'X000',
    description: null,
    preparation: null,
    turnaroundHours: null,
    pricePrivate: 0,
    priceInsurance: 0,
    category: null,
    isActive: true,
    createdAt: '',
    updatedAt: '',
    tussCode: null,
    ambCode: null,
    material: null,
    source: 'manual',
    synonyms: [],
    ...overrides,
  };
}

const CATALOG: Exam[] = [
  exam({ id: 'e-3', name: 'Hemograma', code: 'HEM001', category: 'Hematologia' }),
  exam({ id: 'e-2', name: 'Bilirrubina Direta', code: 'BIO015', category: 'Bioquímica', synonyms: ['BD'] }),
  exam({ id: 'e-1', name: 'Ácido Úrico', code: 'BIO009', category: 'Bioquímica', synonyms: ['Acido Urico'] }),
  exam({ id: 'e-4', name: 'Avulso', code: 'Z1', category: null }),
];

function infiniteResult(exams: Exam[]) {
  return {
    data: {
      pages: [{ exams, pagination: { page: 1, limit: 100, total: exams.length, totalPages: 1 } }],
      pageParams: [1],
    },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  } as unknown as ReturnType<typeof examsApi.useExamListInfinite>;
}

function Harness({ initial = [] }: { initial?: PickedExam[] }) {
  const [value, setValue] = useState<PickedExam[]>(initial);
  return <ExamPicker value={value} onChange={setValue} />;
}

describe('ExamPicker (CRMLAB-77, D-247)', () => {
  beforeEach(() => {
    useExamListInfinite.mockReset();
    useExamListInfinite.mockReturnValue(infiniteResult(CATALOG));
  });

  it('agrupa por categoria em ordem alfabética, com sinônimos e código, e "Sem categoria" no fim', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: /selecione exames/i }));

    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['Bioquímica', 'Hematologia', 'Sem categoria']);

    const bio = within(screen.getByRole('group', { name: 'Bioquímica' }));
    const names = bio.getAllByRole('option').map((o) => o.textContent);
    expect(names[0]).toContain('Ácido Úrico');
    expect(names[0]).toContain('Acido Urico');
    expect(names[0]).toContain('BIO009');
    expect(names[1]).toContain('Bilirrubina Direta');
  });

  it('só pede exames ativos, ordenados por categoria', () => {
    render(<Harness />);
    expect(useExamListInfinite).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, sortBy: 'category', search: undefined }),
    );
  });

  it('manda o termo digitado para a busca do servidor', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: /selecione exames/i }));
    await user.type(screen.getByLabelText('Buscar exame'), 'bd');

    await waitFor(() =>
      expect(useExamListInfinite).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'bd' })),
    );
  });

  it('marca, desmarca e remove pelo chip', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: /selecione exames/i }));
    await user.click(screen.getByRole('option', { name: /Ácido Úrico/ }));
    await user.click(screen.getByRole('option', { name: /Hemograma/ }));

    expect(screen.getByRole('button', { name: /2 exame\(s\) selecionado\(s\)/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Hemograma/ })).toHaveAttribute('aria-selected', 'true');

    const chips = within(screen.getByRole('list', { name: 'Exames selecionados' }));
    expect(chips.getAllByRole('listitem')).toHaveLength(2);

    await user.click(screen.getByRole('option', { name: /Hemograma/ }));
    expect(chips.getAllByRole('listitem')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Remover Ácido Úrico' }));
    expect(screen.queryByRole('list', { name: 'Exames selecionados' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /selecione exames/i })).toBeInTheDocument();
  });

  it('mantém o chip de exame que saiu do resultado da busca', () => {
    useExamListInfinite.mockReturnValue(infiniteResult([]));
    render(<Harness initial={[{ id: 'e-9', name: 'Ferritina' }]} />);
    expect(screen.getByText('Ferritina')).toBeInTheDocument();
  });
});
