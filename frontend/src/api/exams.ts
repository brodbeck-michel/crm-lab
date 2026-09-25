import type {
  CreateExamRequest,
  Exam,
  ExamImportPreview,
  ExamImportResult,
  ImportExamCatalogRequest,
  ListExamPricesResponse,
  ListExamsQuery,
  ListExamsResponse,
  UpdateExamPricesRequest,
  UpdateExamRequest,
} from '@crm-lab/shared';
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { http } from './client';
import { queryKeys } from './query-keys';
import type { QueryParams } from './client';

/** docs/api/API_CONTRACTS.md §4 — Exam Catalog. Escrita só para gestor/admin. */
export const examsApi = {
  list: (query: ListExamsQuery = {}) => http.get<ListExamsResponse>('/exams', query as QueryParams),

  create: (body: CreateExamRequest) => http.post<Exam>('/exams', body),

  update: (id: string, body: UpdateExamRequest) => http.patch<Exam>(`/exams/${id}`, body),

  /** `GET /exams/:id/prices` (§4/§8) — todos os papéis do tenant. */
  prices: (id: string) => http.get<ListExamPricesResponse>(`/exams/${id}/prices`),

  /** `PUT /exams/:id/prices` (§4/§8, manager/admin) — semântica de PUT: estado completo. */
  updatePrices: (id: string, body: UpdateExamPricesRequest) =>
    http.put<ListExamPricesResponse>(`/exams/${id}/prices`, body),

  /** `POST /exams/import/preview` (§4, admin, CRMLAB-23) — não grava nada. */
  previewImport: (body: ImportExamCatalogRequest) =>
    http.post<ExamImportPreview>('/exams/import/preview', body),

  /** `POST /exams/import` (§4, admin, CRMLAB-23) — mesmo arquivo; tudo ou nada. */
  confirmImport: (body: ImportExamCatalogRequest) =>
    http.post<ExamImportResult>('/exams/import', body),
};

/* ── React Query Hooks ──────────────────────────────────────────────────── */

/**
 * Devolve a resposta INTEIRA (`exams` + `pagination`) — ver o mesmo comentário
 * em `useProposalList`: descartar o `pagination` era o que tornava o catálogo
 * inteiro invisível a partir do 21º exame (D7 da Onda 5).
 */
export function useExamList(filters: ListExamsQuery = {}) {
  return useQuery({
    queryKey: queryKeys.exams(filters),
    queryFn: async () => {
      return await examsApi.list(filters);
    },
  });
}

/** Filtros do seletor: a página é do hook, não de quem chama. */
export type ExamListInfiniteFilters = Omit<ListExamsQuery, 'page'>;

/**
 * Catálogo em páginas ACUMULADAS — o seletor de `/budget/new` (D-080).
 *
 * `/proposals` e `/catalog` são tabelas: trocar a página é o gesto certo lá.
 * Montar um orçamento não é: o usuário está construindo um carrinho e trocar
 * a página do catálogo sob ele seria perder o lugar. Aqui cada página nova
 * ENTRA na lista, e o `search` (que já é server-side, `docs/api/API_CONTRACTS.md`
 * §4) recorta o conjunto inteiro no banco — não as 20 linhas que a tela tem.
 *
 * Antes disso a coluna chamava `useExamList` e renderizava `data.exams`: um
 * laboratório com mais exames ativos do que cabia numa página não conseguia
 * montar orçamento com o resto do catálogo. Era a metade da D7 da Onda 5 que
 * ficou aberta.
 */
export function useExamListInfinite(filters: ExamListInfiniteFilters = {}) {
  return useInfiniteQuery({
    queryKey: queryKeys.examsInfinite(filters),
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      return await examsApi.list({ ...filters, page: pageParam });
    },
    getNextPageParam: (last: ListExamsResponse) => {
      const { page, totalPages } = last.pagination;
      return page < totalPages ? page + 1 : undefined;
    },
  });
}

export function useCreateExam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateExamRequest) => {
      return await examsApi.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.exams() });
    },
  });
}

export function useUpdateExam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateExamRequest }) => {
      return await examsApi.update(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.exams() });
    },
  });
}

/** Preço do exame por convênio — aba "Preços por convênio" de `ExamModal`. */
export function useExamPrices(examId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.examPrices(examId ?? ''),
    queryFn: async () => {
      return await examsApi.prices(examId as string);
    },
    enabled: !!examId,
  });
}

export function useUpdateExamPrices() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateExamPricesRequest }) => {
      return await examsApi.updatePrices(id, data);
    },
    onSuccess: (result, { id }) => {
      queryClient.setQueryData(queryKeys.examPrices(id), result);
      // `updatePrices` também muda `effectivePrice` do catálogo (§4) — mesmo
      // prefixo que `useUpdateExam` invalida.
      queryClient.invalidateQueries({ queryKey: queryKeys.exams() });
    },
  });
}

/** Pré-visualização do CSV do catálogo — nada é gravado, nada a invalidar. */
export function usePreviewExamImport() {
  return useMutation({
    mutationFn: async (body: ImportExamCatalogRequest) => {
      return await examsApi.previewImport(body);
    },
  });
}

/** Confirma a importação; a listagem do catálogo recarrega (mesmo prefixo de `useUpdateExam`). */
export function useConfirmExamImport() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: ImportExamCatalogRequest) => {
      return await examsApi.confirmImport(body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.exams() });
    },
  });
}
