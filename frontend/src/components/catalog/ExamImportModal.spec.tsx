import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExamImportPreview,
  ExamImportResult,
  ImportExamCatalogRequest,
} from '@crm-lab/shared';
import { ToastProvider } from '@/components/ui';
import { ApiError } from '@/api/client';
import { mutationIdle } from '@/test/query-mocks';
import * as examsApi from '@/api/exams';
import ExamImportModal from './ExamImportModal';

/**
 * CRMLAB-23 (D-177/D-178, PAGES.md §7). Hooks de `@/api/exams` mockados com
 * shape tipado (`query-mocks.ts`); o `mutate` de cada um chama o callback que
 * o modal passa, como o React Query faria com a resposta do servidor.
 */
vi.mock('@/api/exams', async () => {
  const actual = await vi.importActual('@/api/exams');
  return {
    ...actual,
    usePreviewExamImport: vi.fn(),
    useConfirmExamImport: vi.fn(),
  };
});

type PreviewMutate = ReturnType<typeof examsApi.usePreviewExamImport>['mutate'];
type ConfirmMutate = ReturnType<typeof examsApi.useConfirmExamImport>['mutate'];

type Callbacks<T> = { onSuccess?: (data: T) => void; onError?: (err: unknown) => void };

function resolvesWith<T>(data: T) {
  return vi.fn((_body: ImportExamCatalogRequest, opts?: Callbacks<T>) => {
    opts?.onSuccess?.(data);
  });
}

function rejectsWith(err: unknown) {
  return vi.fn((_body: ImportExamCatalogRequest, opts?: Callbacks<unknown>) => {
    opts?.onError?.(err);
  });
}

const PREVIEW_OK: ExamImportPreview = {
  fileName: 'catalogo.csv',
  totalRows: 2,
  createCount: 1,
  updateCount: 1,
  errorCount: 0,
  errors: [],
  errorsTruncated: false,
  rows: [
    {
      line: 2,
      action: 'update',
      code: 'HC',
      name: 'Hemograma completo',
      category: 'Hematologia',
      turnaroundHours: 24,
      pricePrivate: 89.9,
      priceInsurance: 75,
    },
    {
      line: 3,
      action: 'create',
      code: 'VITD',
      name: 'Vitamina D',
      category: null,
      turnaroundHours: null,
      pricePrivate: 1234.56,
      priceInsurance: 95,
    },
  ],
};

const PREVIEW_WITH_ERRORS: ExamImportPreview = {
  ...PREVIEW_OK,
  totalRows: 3,
  errorCount: 1,
  errors: [{ line: 4, column: 'preco_particular', message: 'Preço inválido: "abc"' }],
};

const CSV = 'nome;codigo;preco_convenio;preco_particular\nHemograma;HC;75;89,90\n';

function csvFile(): File {
  return new File([CSV], 'catalogo.csv', { type: 'text/csv' });
}

function renderModal(onClose = vi.fn()) {
  render(
    <ToastProvider>
      <ExamImportModal onClose={onClose} />
    </ToastProvider>,
  );
  return { onClose };
}

async function upload(user: ReturnType<typeof userEvent.setup>) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('input de arquivo nao encontrado');
  await user.upload(input, csvFile());
}

describe('ExamImportModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(examsApi.usePreviewExamImport).mockReturnValue(mutationIdle());
    vi.mocked(examsApi.useConfirmExamImport).mockReturnValue(mutationIdle());
  });

  it('pré-visualiza: contadores, linhas válidas e confirmar habilitado; confirmar reenvia o MESMO arquivo', async () => {
    const user = userEvent.setup();
    const preview = resolvesWith(PREVIEW_OK);
    const result: ExamImportResult = { fileName: 'catalogo.csv', totalRows: 2, created: 1, updated: 1 };
    const confirm = resolvesWith(result);
    vi.mocked(examsApi.usePreviewExamImport).mockReturnValue(
      mutationIdle(preview as unknown as PreviewMutate),
    );
    vi.mocked(examsApi.useConfirmExamImport).mockReturnValue(
      mutationIdle(confirm as unknown as ConfirmMutate),
    );
    const { onClose } = renderModal();

    await upload(user);

    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    const sent = preview.mock.calls[0]?.[0];
    expect(sent?.fileName).toBe('catalogo.csv');
    expect(atob(sent?.contentBase64 ?? '')).toBe(CSV);

    expect(await screen.findByText('Novos')).toBeInTheDocument();
    expect(screen.getByText('Atualizam')).toBeInTheDocument();
    expect(screen.getByText('Com erro')).toBeInTheDocument();
    const valid = screen.getByRole('region', { name: 'Linhas válidas' });
    expect(within(valid).getByRole('cell', { name: 'VITD' })).toBeInTheDocument();
    expect(within(valid).getByRole('cell', { name: 'Novo' })).toBeInTheDocument();
    expect(within(valid).getByRole('cell', { name: 'Atualiza' })).toBeInTheDocument();
    // Nada gravado ainda: confirmar nao foi chamado.
    expect(confirm).not.toHaveBeenCalled();

    const confirmButton = screen.getByRole('button', { name: 'Confirmar importação' });
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toEqual(sent);
    expect(await screen.findByText(/1 criado\(s\), 1 atualizado\(s\)/)).toBeInTheDocument();
    expect(onClose).toHaveBeenCalled();
  });

  it('com linha de erro mostra linha/coluna/motivo e deixa confirmar desabilitado', async () => {
    const user = userEvent.setup();
    vi.mocked(examsApi.usePreviewExamImport).mockReturnValue(
      mutationIdle(resolvesWith(PREVIEW_WITH_ERRORS) as unknown as PreviewMutate),
    );
    renderModal();

    await upload(user);

    const errors = await screen.findByRole('region', { name: 'Linhas com erro' });
    expect(within(errors).getByRole('cell', { name: '4' })).toBeInTheDocument();
    expect(within(errors).getByRole('cell', { name: 'Preço particular' })).toBeInTheDocument();
    expect(within(errors).getByRole('cell', { name: 'Preço inválido: "abc"' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirmar importação' })).toBeDisabled();
  });

  it('arquivo recusado inteiro vira mensagem em pt-BR (missing_column)', async () => {
    const user = userEvent.setup();
    const err = new ApiError('VALIDATION_ERROR', 'Dados invalidos', 400, {
      reason: 'missing_column',
      columns: ['preco_particular'],
    });
    vi.mocked(examsApi.usePreviewExamImport).mockReturnValue(
      mutationIdle(rejectsWith(err) as unknown as PreviewMutate),
    );
    renderModal();

    await upload(user);

    expect(
      await screen.findByText(/Faltam colunas obrigatórias: Preço particular/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar importação' })).not.toBeInTheDocument();
  });

  it('"Escolher outro arquivo" volta para o upload', async () => {
    const user = userEvent.setup();
    vi.mocked(examsApi.usePreviewExamImport).mockReturnValue(
      mutationIdle(resolvesWith(PREVIEW_OK) as unknown as PreviewMutate),
    );
    renderModal();

    await upload(user);
    await user.click(await screen.findByRole('button', { name: 'Escolher outro arquivo' }));

    expect(screen.getByText(/Arraste a planilha aqui/)).toBeInTheDocument();
    expect(screen.queryByText('Novos')).not.toBeInTheDocument();
  });

  it('"Baixar modelo" gera o CSV modelo', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:modelo');
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    // jsdom nao navega: o clique no <a download> so precisa acontecer.
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderModal();

    await user.click(screen.getByRole('button', { name: 'Baixar modelo' }));

    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:modelo');
  });
});
