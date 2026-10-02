import { ALLOWED_MEDIA_MIME_TYPES, MAX_MEDIA_BYTES, isAllowedMediaMimeType } from '@crm-lab/shared';

/**
 * Anexo na prévia, antes de subir (CRMLAB-69, D-232).
 *
 * A validação é a MESMA do backend (D-169: allow-list normalizada + 15 MiB),
 * com os números de `shared/`. É só UX: o backend valida de novo.
 */
export interface AttachmentDraft {
  /** Chave local (lista, miniatura selecionada) — não vai para a API. */
  id: string;
  file: File;
  /** Uma legenda por arquivo; vazia = sem legenda. */
  caption: string;
  /** Preenchido = o arquivo fica na prévia com o aviso e não sobe. */
  error: string | null;
}

/** `accept` do "Documento" e do **+** da prévia: a allow-list inteira, sem lista nova. */
export const DOCUMENT_ACCEPT = ALLOWED_MEDIA_MIME_TYPES.join(',');

/** `accept` de "Fotos e vídeos". */
export const MEDIA_ACCEPT = 'image/*,video/*';

/** Aviso do arquivo que não pode subir, ou `null`. */
export function validateAttachment(file: File): string | null {
  if (!isAllowedMediaMimeType(file.type || '')) return 'Tipo de arquivo não permitido';
  if (file.size === 0) return 'Arquivo vazio';
  if (file.size > MAX_MEDIA_BYTES) return 'Arquivo acima de 15 MB';
  return null;
}

let sequence = 0;

export function createAttachmentDraft(file: File): AttachmentDraft {
  sequence += 1;
  return { id: `draft-${sequence}`, file, caption: '', error: validateAttachment(file) };
}

/** `1,2 MB`, `340 KB`, `12 B` — o tamanho que a prévia mostra. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}

/** Arquivos da área de transferência/arrasto (ignora texto e itens que não são arquivo). */
export function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files && data.files.length > 0) return Array.from(data.files);
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/** Arrasto que carrega arquivo (arrastar texto não mostra a área de soltar). */
export function dragHasFiles(data: DataTransfer | null): boolean {
  return Array.from(data?.types ?? []).includes('Files');
}
