import { useState } from 'react';
import type { MessageMediaInfo, MessageType } from '@crm-lab/shared';
import { fetchAuthenticatedBlob, resolveMediaUrl } from '@/api';
import { formatBytes } from './attachment-draft';
import { isProtectedMediaUrl } from './media-url';

export interface DocumentCardProps {
  /** `message.attachmentUrl`. */
  url: string;
  /** `pdf` abre em nova aba; o resto baixa. */
  messageType: MessageType;
  media?: MessageMediaInfo | null;
}

/** Rótulo do ícone pelo tipo do arquivo (D-236 item 4). */
export function documentKindLabel(mimeType: string | null, fileName: string | null): string {
  const mime = (mimeType ?? '').toLowerCase();
  const ext = (fileName?.split('.').pop() ?? '').toLowerCase();
  if (mime === 'application/pdf' || ext === 'pdf') return 'PDF';
  if (
    mime.includes('wordprocessing') ||
    mime === 'application/msword' ||
    ext === 'doc' ||
    ext === 'docx'
  ) {
    return 'DOC';
  }
  if (
    mime.includes('spreadsheet') ||
    mime === 'application/vnd.ms-excel' ||
    ['xls', 'xlsx'].includes(ext)
  ) {
    return 'XLS';
  }
  if (mime.includes('presentation') || ['ppt', 'pptx'].includes(ext)) return 'PPT';
  if (mime === 'text/csv' || ext === 'csv') return 'CSV';
  if (mime.startsWith('text/') || ext === 'txt') return 'TXT';
  if (mime.startsWith('video/')) return 'VÍD';
  return 'ARQ';
}

/**
 * DocumentCard — documento como no WhatsApp Web (CRMLAB-70, D-236 item 4):
 * ícone do tipo, nome, tamanho e, no PDF, páginas quando o WhatsApp informa.
 *
 * O blob só é buscado NO CLIQUE (revisão do PR #43): buscar na montagem
 * baixava até 15 MiB por mensagem só para desenhar o cartão. PDF abre em nova
 * aba (o blob carrega o `Content-Type` certo); qualquer outro anexo baixa.
 * Anexo hospedado fora do nosso backend vira link cru, sem token.
 */
export function DocumentCard({ url, messageType, media }: DocumentCardProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const isPdf = messageType === 'pdf';
  const fileName = media?.fileName ?? null;
  const details = [
    media ? formatBytes(media.fileSize) : null,
    media?.pageCount ? `${media.pageCount} ${media.pageCount === 1 ? 'página' : 'páginas'}` : null,
  ].filter((part): part is string => part !== null);

  const open = async (): Promise<void> => {
    if (state === 'loading') return;
    setState('loading');
    try {
      const { blob, fileName: served } = await fetchAuthenticatedBlob(resolveMediaUrl(url));
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      if (isPdf) {
        anchor.target = '_blank';
        anchor.rel = 'noreferrer';
      } else {
        anchor.download = served ?? fileName ?? 'anexo';
      }
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoga depois que o navegador já abriu/baixou; imediato quebra o download.
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      setState('idle');
    } catch {
      setState('error');
    }
  };

  const body = (
    <>
      <span
        aria-hidden="true"
        className="flex h-[40px] w-[36px] shrink-0 items-center justify-center rounded-sm bg-accent-700 font-body text-micro font-semibold text-surface"
      >
        {documentKindLabel(media?.mimeType ?? null, fileName)}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-label font-semibold text-text">
          {state === 'loading'
            ? 'Carregando anexo…'
            : (fileName ?? (isPdf ? 'Documento PDF' : 'Documento'))}
        </span>
        <span className="text-caption text-neutral-600">
          {details.length > 0 ? details.join(' · ') : isPdf ? 'Abrir' : 'Baixar'}
        </span>
      </span>
    </>
  );
  // "Abrir anexo …"/"Baixar anexo …": o mesmo nome acessível de antes do cartão.
  const actionLabel = `${isPdf ? 'Abrir' : 'Baixar'} anexo${fileName ? ` ${fileName}` : ''}`;
  const shell =
    'flex min-w-0 items-center gap-sm self-stretch rounded-md border border-neutral-200 bg-surface px-sm py-xs text-left font-body no-underline';

  if (!isProtectedMediaUrl(url)) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        data-testid="document-card"
        aria-label={actionLabel}
        className={shell}
      >
        {body}
      </a>
    );
  }

  return (
    <>
      <button
        type="button"
        data-testid="document-card"
        aria-label={actionLabel}
        onClick={() => void open()}
        disabled={state === 'loading'}
        className={`${shell} cursor-pointer hover:bg-neutral-100 disabled:cursor-progress`}
      >
        {body}
      </button>
      {state === 'error' && (
        <span className="text-caption text-neutral-600">Não foi possível carregar o anexo</span>
      )}
    </>
  );
}
