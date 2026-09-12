import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { cn } from '@/components/ui/cn';

export interface UploadDropzoneProps {
  /** Extensão aceita, com ponto (ex.: `.xlsx`). */
  accept: string;
  /** Teto de tamanho, checado no CLIENTE antes de chamar `onFile` (§14). */
  maxSizeBytes: number;
  onFile: (file: File) => void;
  disabled?: boolean;
}

/**
 * `UploadDropzone` (`docs/frontend/COMPONENTS.md`) — área clicável +
 * arrastar-e-soltar, um arquivo por vez. Valida extensão e tamanho no
 * cliente ANTES de chamar `onFile`; o servidor tem o mesmo teto
 * (`LIS_IMPORT_MAX_BYTES`), mas recusar cedo evita gastar banda com um
 * arquivo que seria rejeitado de qualquer forma.
 */
export function UploadDropzone({ accept, maxSizeBytes, onFile, disabled }: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validate(file: File): string | null {
    if (!file.name.toLowerCase().endsWith(accept.toLowerCase())) {
      return `Só arquivos ${accept}.`;
    }
    if (file.size > maxSizeBytes) {
      const maxMib = (maxSizeBytes / (1024 * 1024)).toFixed(0);
      return `Arquivo maior que ${maxMib} MiB.`;
    }
    return null;
  }

  function handleFile(file: File | undefined) {
    if (!file) return;
    const problem = validate(file);
    setError(problem);
    if (!problem) onFile(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    if (disabled) return;
    handleFile(event.dataTransfer.files[0]);
  }

  return (
    <div className="space-y-sm">
      <div
        role="button"
        tabIndex={0}
        aria-disabled={disabled}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          'flex flex-col items-center justify-center gap-sm rounded-md border-2 border-dashed p-xl text-center cursor-pointer',
          dragOver ? 'border-accent-500 bg-accent-100' : 'border-neutral-300',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
      >
        <p className="font-body text-body text-neutral-800">
          Arraste a planilha aqui ou clique para escolher
        </p>
        <p className="font-body text-caption text-neutral-600">
          Arquivo {accept}, até {(maxSizeBytes / (1024 * 1024)).toFixed(0)} MiB
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={disabled}
        className="hidden"
        onChange={(e) => {
          handleFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {error && (
        <p role="alert" className="font-body text-caption text-accent-700">
          {error}
        </p>
      )}
    </div>
  );
}
