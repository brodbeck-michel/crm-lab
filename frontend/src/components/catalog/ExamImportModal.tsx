import { useState } from 'react';
import {
  EXAM_IMPORT_MAX_BYTES,
  EXAM_IMPORT_MAX_ROWS,
  type ExamImportColumn,
  type ExamImportInvalidReason,
  type ExamImportPreview,
  type ExamImportRow,
  type ExamImportRowError,
  type ImportExamCatalogRequest,
} from '@crm-lab/shared';
import { useConfirmExamImport, usePreviewExamImport } from '@/api/exams';
import { isApiError } from '@/api/client';
import { Button, useToast } from '@/components/ui';
import { DataTable, Modal, MoneyDisplay, type DataTableColumn } from '@/components/shared';
import { UploadDropzone } from '@/components/lis/UploadDropzone';
import { downloadExamImportTemplate } from '@/lib/catalog/exam-import-template';

export interface ExamImportModalProps {
  onClose: () => void;
}

const COLUMN_LABEL: Record<ExamImportColumn, string> = {
  nome: 'Nome',
  codigo: 'Código',
  categoria: 'Categoria',
  descricao: 'Descrição',
  preparo: 'Preparo',
  prazo_horas: 'Prazo (horas)',
  preco_convenio: 'Preço convênio',
  preco_particular: 'Preço particular',
};

function listColumns(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((column) => COLUMN_LABEL[column as ExamImportColumn] ?? String(column))
    .join(', ');
}

/** `details.reason` de API_CONTRACTS.md §4 → mensagem em pt-BR. */
function reasonMessage(reason: ExamImportInvalidReason, details: Record<string, unknown>): string {
  switch (reason) {
    case 'invalid_encoding':
      return 'O arquivo não está em UTF-8. No Excel, use "Salvar como" → "CSV UTF-8" e envie de novo.';
    case 'malformed':
      return 'O arquivo tem aspas abertas que nunca fecham. Confira a planilha e envie de novo.';
    case 'empty':
      return 'A planilha não tem nenhuma linha de exame.';
    case 'missing_column':
      return `Faltam colunas obrigatórias: ${listColumns(details.columns)}. Baixe o modelo para ver o cabeçalho esperado.`;
    case 'duplicate_column':
      return `Coluna repetida no cabeçalho: ${listColumns(details.columns)}.`;
    case 'too_many_rows':
      return `A planilha tem ${String(details.rows ?? '')} linhas; o máximo é ${EXAM_IMPORT_MAX_ROWS}. Divida em arquivos menores.`;
    case 'invalid_rows':
      return 'A planilha tem linhas com erro — nada foi gravado. Corrija e envie de novo.';
  }
}

function errorMessage(err: unknown): string {
  if (isApiError(err) && err.code === 'VALIDATION_ERROR') {
    const reason = err.details?.reason as ExamImportInvalidReason | undefined;
    if (reason) return reasonMessage(reason, err.details ?? {});
    return 'Arquivo inválido.';
  }
  if (isApiError(err) && err.code === 'MEDIA_TOO_LARGE') return 'Arquivo maior que 2 MiB.';
  if (isApiError(err) && err.code === 'FORBIDDEN') {
    return 'Só o administrador do laboratório pode importar o catálogo.';
  }
  return 'Não foi possível ler a planilha. Tente de novo.';
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

const ERROR_COLUMNS: Array<DataTableColumn<ExamImportRowError>> = [
  { key: 'line', header: 'Linha', render: (error) => error.line },
  {
    key: 'column',
    header: 'Coluna',
    render: (error) => (error.column ? COLUMN_LABEL[error.column] : '—'),
  },
  { key: 'message', header: 'Motivo', render: (error) => error.message },
];

const ROW_COLUMNS: Array<DataTableColumn<ExamImportRow>> = [
  { key: 'line', header: 'Linha', render: (row) => row.line },
  {
    key: 'action',
    header: 'Ação',
    render: (row) => (row.action === 'create' ? 'Novo' : 'Atualiza'),
  },
  { key: 'code', header: 'Código', render: (row) => row.code },
  { key: 'name', header: 'Nome', render: (row) => row.name },
  {
    key: 'pricePrivate',
    header: 'Preço particular',
    align: 'right',
    render: (row) => <MoneyDisplay value={row.pricePrivate} />,
  },
  {
    key: 'priceInsurance',
    header: 'Preço convênio',
    align: 'right',
    render: (row) => <MoneyDisplay value={row.priceInsurance} />,
  },
];

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-xs rounded-md border border-neutral-300 p-md">
      <span className="font-body text-caption text-neutral-600">{label}</span>
      <span className="font-heading text-section text-neutral-900">{value}</span>
    </div>
  );
}

/**
 * Importar catálogo por CSV (CRMLAB-23, D-177/D-178, PAGES.md §7) — só admin.
 * Dois passos com o MESMO arquivo: pré-visualizar (não grava) e confirmar
 * (grava tudo ou nada). O servidor não guarda o preview, então o arquivo lido
 * fica aqui no estado e é reenviado na confirmação.
 */
export default function ExamImportModal({ onClose }: ExamImportModalProps) {
  const { toast } = useToast();
  const previewImport = usePreviewExamImport();
  const confirmImport = useConfirmExamImport();
  const [file, setFile] = useState<ImportExamCatalogRequest | null>(null);
  const [preview, setPreview] = useState<ExamImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(selected: File) {
    setError(null);
    setPreview(null);
    let request: ImportExamCatalogRequest;
    try {
      request = { fileName: selected.name, contentBase64: await readFileAsBase64(selected) };
    } catch {
      setError('Não foi possível ler o arquivo.');
      return;
    }
    setFile(request);
    previewImport.mutate(request, {
      onSuccess: (result) => setPreview(result),
      onError: (err) => setError(errorMessage(err)),
    });
  }

  function handleConfirm() {
    if (!file) return;
    setError(null);
    confirmImport.mutate(file, {
      onSuccess: (result) => {
        toast(
          `Catálogo importado: ${result.created} criado(s), ${result.updated} atualizado(s).`,
          { tone: 'positive' },
        );
        onClose();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  }

  function reset() {
    setFile(null);
    setPreview(null);
    setError(null);
  }

  const canConfirm =
    preview !== null &&
    preview.errorCount === 0 &&
    preview.rows.length > 0 &&
    !confirmImport.isPending;

  const footer = preview ? (
    <div className="flex justify-end gap-sm">
      <Button variant="secondary" onClick={reset} disabled={confirmImport.isPending}>
        Escolher outro arquivo
      </Button>
      <Button variant="primary" onClick={handleConfirm} disabled={!canConfirm}>
        {confirmImport.isPending ? 'Importando...' : 'Confirmar importação'}
      </Button>
    </div>
  ) : undefined;

  return (
    <Modal open onClose={onClose} title="Importar catálogo (CSV)" footer={footer}>
      <div className="flex flex-col gap-md">
        <div className="flex items-start justify-between gap-md">
          <p className="font-body text-caption text-neutral-600">
            Planilha CSV em UTF-8, separada por ponto e vírgula ou vírgula, com as colunas nome,
            código e os dois preços. Código que já existe no catálogo é atualizado; célula vazia
            mantém o valor atual. Nada é gravado antes de você confirmar.
          </p>
          <Button variant="secondary" size="sm" onClick={downloadExamImportTemplate}>
            Baixar modelo
          </Button>
        </div>

        {!preview && (
          <UploadDropzone
            accept=".csv"
            maxSizeBytes={EXAM_IMPORT_MAX_BYTES}
            onFile={(selected) => void handleFile(selected)}
            disabled={previewImport.isPending}
          />
        )}
        {previewImport.isPending && (
          <p className="font-body text-caption text-neutral-600">Lendo a planilha...</p>
        )}

        {preview && (
          <div className="flex flex-col gap-md">
            <p className="font-body text-caption text-neutral-600">
              {preview.fileName} — {preview.totalRows} linha(s) lida(s)
            </p>
            <div className="grid grid-cols-3 gap-sm">
              <Counter label="Novos" value={preview.createCount} />
              <Counter label="Atualizam" value={preview.updateCount} />
              <Counter label="Com erro" value={preview.errorCount} />
            </div>

            {preview.errorCount > 0 && (
              <section aria-label="Linhas com erro" className="flex flex-col gap-sm">
                <p role="alert" className="font-body text-caption text-accent-700">
                  Corrija as linhas abaixo e envie o arquivo de novo — a importação é tudo ou
                  nada.
                </p>
                <DataTable
                  columns={ERROR_COLUMNS}
                  rows={preview.errors}
                  rowKey={(item, index) => `${item.line}-${item.column ?? 'linha'}-${index}`}
                  minWidth={560}
                />
                {preview.errorsTruncated && (
                  <p className="font-body text-caption text-neutral-600">
                    Mostrando os primeiros {preview.errors.length} erros.
                  </p>
                )}
              </section>
            )}

            {preview.rows.length > 0 && (
              <section aria-label="Linhas válidas" className="flex flex-col gap-sm">
                <DataTable
                  columns={ROW_COLUMNS}
                  rows={preview.rows}
                  rowKey={(row) => String(row.line)}
                  minWidth={640}
                />
              </section>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="font-body text-caption text-accent-700">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
