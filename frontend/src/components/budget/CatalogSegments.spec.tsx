import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Exam, ListExamsQuery, ListExamsResponse } from '@crm-lab/shared';
import type * as ApiClient from '@/api/client';
import CatalogSegments from './CatalogSegments';

/**
 * D-080 — o seletor do orçamento alcança o catálogo INTEIRO.
 *
 * A versão com o defeito pedia UMA página e renderizava `data.exams`: exame
 * fora dela era inalcançável, e um laboratório com catálogo grande não
 * conseguia montar orçamento com o resto. O que estes testes provam é
 * CONTEÚDO: o último exame do alfabeto não está na tela, e passa a estar
 * depois de "Carregar mais" — e é clicável (chama `onAddItem`).
 *
 * O `http.get` falso pagina de verdade sobre um catálogo de 55 exames e
 * respeita `search`, então "busca é server-side" também fica sob teste: o
 * componente nunca filtra o que já carregou.
 */

/** Maior que o `limit: 50` da versão com defeito — 25 caberiam nela. */
const TOTAL = 55;
const PAGE_SIZE = 20;

function fakeExam(index: number): Exam {
  const suffix = String(index).padStart(2, '0');
  return {
    id: `exam-${suffix}`,
    name: `Exame ${suffix}`,
    code: `EX${suffix}`,
    description: null,
    preparation: null,
    turnaroundHours: null,
    pricePrivate: 10 + index,
    priceInsurance: 5 + index,
    category: null,
    isActive: true,
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    tussCode: null,
    ambCode: null,
    material: null,
    source: 'manual',
    synonyms: [],
  };
}

/** Catálogo inteiro, já em `name ASC` — `Exame 00` … `Exame 54`. */
const CATALOGO: Exam[] = Array.from({ length: TOTAL }, (_, i) => fakeExam(i));

/** `vi.mock` é içado para o topo do arquivo: o mock precisa nascer içado também. */
const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClient>('@/api/client');
  return { ...actual, http: { ...actual.http, get } };
});

/** Servidor de mentira que pagina e busca como `GET /exams` (§4). */
function serve(query: ListExamsQuery): ListExamsResponse {
  const term = query.search?.toLowerCase() ?? '';
  const matched = CATALOGO.filter(
    (exam) =>
      term.length === 0 ||
      exam.name.toLowerCase().includes(term) ||
      exam.code.toLowerCase().includes(term),
  );
  const limit = query.limit ?? PAGE_SIZE;
  const page = query.page ?? 1;
  return {
    exams: matched.slice((page - 1) * limit, page * limit),
    pagination: {
      page,
      limit,
      total: matched.length,
      totalPages: matched.length === 0 ? 0 : Math.ceil(matched.length / limit),
    },
  };
}

function renderCatalog(onAddItem = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CatalogSegments insuranceId={null} onInsuranceChange={() => {}} onAddItem={onAddItem} />
    </QueryClientProvider>,
  );
  return onAddItem;
}

describe('CatalogSegments — alcance do catálogo (D-080)', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation((_path: string, query: ListExamsQuery) =>
      Promise.resolve(serve(query)),
    );
  });

  it('pede só a primeira página e anuncia quanto do catálogo falta', async () => {
    renderCatalog();

    await waitFor(() => {
      expect(screen.getByText(`${PAGE_SIZE} de ${TOTAL} exames`)).toBeInTheDocument();
    });
    expect(screen.getByText('Exame 00')).toBeInTheDocument();
    expect(screen.getByText('EX00')).toBeInTheDocument();
    // O fim do alfabeto ainda NÃO está na tela — é o que "Carregar mais" resolve.
    expect(screen.queryByText('Exame 54')).not.toBeInTheDocument();
  });

  it('"Carregar mais" ACUMULA páginas até o último exame, que entra no orçamento', async () => {
    const user = userEvent.setup();
    const onAddItem = renderCatalog();

    await waitFor(() => {
      expect(screen.getByText(`${PAGE_SIZE} de ${TOTAL} exames`)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => {
      expect(screen.getByText(`${PAGE_SIZE * 2} de ${TOTAL} exames`)).toBeInTheDocument();
    });
    // ACUMULA: a página 1 continua na tela ao lado da 2.
    expect(screen.getByText('Exame 00')).toBeInTheDocument();
    expect(screen.getByText('Exame 20')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Carregar mais' }));
    await waitFor(() => {
      expect(screen.getByText('Exame 54')).toBeInTheDocument();
    });
    // Catálogo inteiro na tela: não há mais o que carregar.
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).not.toBeInTheDocument();

    await user.click(screen.getByText('Exame 54'));
    expect(onAddItem).toHaveBeenCalledWith('exam-54', 'Exame 54', 64, 'private');
  });

  it('a busca vai para o servidor — alcança exame que nunca esteve na tela', async () => {
    const user = userEvent.setup();
    const onAddItem = renderCatalog();

    await waitFor(() => {
      expect(screen.getByText(`${PAGE_SIZE} de ${TOTAL} exames`)).toBeInTheDocument();
    });
    expect(screen.queryByText('Exame 54')).not.toBeInTheDocument();

    await user.type(screen.getByRole('searchbox'), 'EX54');

    await waitFor(() => {
      expect(screen.getByText('Exame 54')).toBeInTheDocument();
    });
    // Um resultado só: nada a carregar, nenhum rodapé.
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).not.toBeInTheDocument();
    // E o termo foi PARA o servidor, não aplicado sobre as linhas carregadas.
    expect(get).toHaveBeenCalledWith('/exams', expect.objectContaining({ search: 'EX54' }));

    await user.click(screen.getByText('Exame 54'));
    expect(onAddItem).toHaveBeenCalledWith('exam-54', 'Exame 54', 64, 'private');
  });
});
