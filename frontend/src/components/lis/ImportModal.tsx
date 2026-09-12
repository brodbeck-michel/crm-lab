import { useState } from 'react';
import type { LisImportInvalidReason } from '@crm-lab/shared';
import { useImportLisSpreadsheet } from '@/api/lis';
import { isApiError } from '@/api/client';
import { useToast } from '@/components/ui';
import { Modal } from '@/components/shared';
import { UploadDropzone } from './UploadDropzone';

const LIS_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

const REASON_MESSAGE: Record<LisImportInvalidReason, string> = {
  pdf_disguised: 'Este arquivo é um PDF, não uma planilha.',
  missing_column: 'A planilha precisa ter a coluna ORÇAMENTO.',
  empty: 'A planilha não tem nenhuma linha de dado.',
};

export interface ImportModalProps {
  onClose: () => void;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

/**
 * Modal "Importar" — usado em `/results` e `/reconciliation` (PAGES.md §14).
 * Um único componente, duas entradas: import de planilha `.xlsx` do LIS.
 */
export function ImportModal({ onClose }: ImportModalProps) {
  const { toast } = useToast();
  const importSpreadsheet = useImportLisSpreadsheet();
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    const contentBase64 = await readFileAsBase64(file);
    importSpreadsheet.mutate(
      { fileName: file.name, contentBase64 },
      {
        onSuccess: (result) => {
          toast(
            `Importação concluída: ${result.rowsAccepted} linha(s) aceitas, ${result.rowsRejected} rejeitada(s).`,
            { tone: 'positive' },
          );
          onClose();
        },
        onError: (err) => {
          if (isApiError(err) && err.code === 'VALIDATION_ERROR') {
            const reason = err.details?.reason as LisImportInvalidReason | undefined;
            setError(reason ? REASON_MESSAGE[reason] : err.message);
            return;
          }
          if (isApiError(err) && err.code === 'MEDIA_TOO_LARGE') {
            setError('Arquivo maior que 10 MiB.');
            return;
          }
          setError('Não foi possível importar a planilha.');
        },
      },
    );
  }

  return (
    <Modal open onClose={onClose} title="Importar planilha do LIS">
      <div className="space-y-md">
        <UploadDropzone
          accept=".xlsx"
          maxSizeBytes={LIS_IMPORT_MAX_BYTES}
          onFile={handleFile}
          disabled={importSpreadsheet.isPending}
        />
        {importSpreadsheet.isPending && (
          <p className="font-body text-caption text-neutral-600">Importando planilha...</p>
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
