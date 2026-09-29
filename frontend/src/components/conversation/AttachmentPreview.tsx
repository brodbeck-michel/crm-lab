import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { MAX_CAPTION_LENGTH } from '@crm-lab/shared';
import { Button, cn } from '@/components/ui';
import { DOCUMENT_ACCEPT, formatBytes } from './attachment-draft';
import type { AttachmentDraft } from './attachment-draft';

/**
 * Prévia de anexos antes de enviar — COMPONENTS.md (`AttachmentPreview`),
 * CRMLAB-69 (D-232/D-233), padrão WhatsApp Web.
 *
 * Componente burro: não chama API, não conhece conversa nem citação. Ocupa
 * 100% do pai — quem monta a tela posiciona por cima da lista + composer, sem
 * desmontá-los.
 */
export interface AttachmentPreviewProps {
  items: readonly AttachmentDraft[];
  onCaptionChange: (id: string, caption: string) => void;
  /** Remover o ÚLTIMO arquivo chama `onClose`, não `onRemove`. */
  onRemove: (id: string) => void;
  /** O **+** da faixa. */
  onAdd: (files: File[]) => void;
  /** Só é chamado com pelo menos um arquivo válido. */
  onSend: () => void;
  /** × ou `Esc`: descarta tudo. */
  onClose: () => void;
}

/**
 * Object URL de UMA imagem: criado por quem desenha e revogado ao desmontar
 * (remover, fechar, enviar) — D-232 item 4. Não-imagem não gera URL.
 */
function useObjectUrl(file: File): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') return;
    const created = URL.createObjectURL(file);
    setUrl(created);
    return () => {
      URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [file]);
  return url;
}

function FileIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function SelectedFile({ draft }: { draft: AttachmentDraft }) {
  const url = useObjectUrl(draft.file);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-sm px-lg py-md">
      {url ? (
        <img
          src={url}
          alt={draft.file.name}
          className="min-h-0 max-w-full flex-1 rounded-md object-contain"
        />
      ) : (
        <div className="flex flex-col items-center gap-xs text-neutral-600">
          <FileIcon size={64} />
          <span className="max-w-full truncate font-body text-label font-semibold text-text">
            {draft.file.name}
          </span>
          <span className="font-body text-caption">{formatBytes(draft.file.size)}</span>
        </div>
      )}
      {draft.error && (
        <p role="alert" className="m-0 font-body text-caption font-semibold text-accent-700">
          {draft.error} — este arquivo não será enviado.
        </p>
      )}
    </div>
  );
}

function Thumbnail({
  draft,
  selected,
  onSelect,
  onRemove,
}: {
  draft: AttachmentDraft;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const url = useObjectUrl(draft.file);
  return (
    <li
      data-testid="attachment-thumb"
      className={cn(
        'relative flex h-[56px] w-[56px] flex-[0_0_56px] list-none items-center justify-center overflow-hidden',
        'rounded-sm border-2 bg-surface',
        selected ? 'border-accent' : 'border-neutral-300',
        draft.error ? 'opacity-60' : '',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Ver ${draft.file.name}`}
        aria-pressed={selected}
        className="flex h-full w-full cursor-pointer items-center justify-center border-none bg-transparent p-0 text-neutral-600"
      >
        {url ? (
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <FileIcon size={24} />
        )}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remover ${draft.file.name}`}
        className="absolute right-0 top-0 flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-pill border-none bg-neutral-700 p-0 font-body text-caption leading-none text-bg"
      >
        ×
      </button>
    </li>
  );
}

export function AttachmentPreview({
  items,
  onCaptionChange,
  onRemove,
  onAdd,
  onSend,
  onClose,
}: AttachmentPreviewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id ?? null);
  const captionRef = useRef<HTMLTextAreaElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  const hasValid = items.some((item) => item.error === null);

  // Abriu ou trocou de arquivo: o cursor vai para a legenda (Enter já envia).
  useEffect(() => {
    captionRef.current?.focus();
  }, [selected?.id]);

  function remove(id: string): void {
    if (items.length <= 1) {
      onClose();
      return;
    }
    if (id === selected?.id) {
      const index = items.findIndex((item) => item.id === id);
      setSelectedId((items[index + 1] ?? items[index - 1])?.id ?? null);
    }
    onRemove(id);
  }

  function send(): void {
    if (hasValid) onSend();
  }

  // Esc fecha a prévia PRIMEIRO; a faixa "Respondendo a…" fica (D-232 item 3).
  // Captura no `document`: o foco pode ter ficado no compositor por baixo (volta
  // do seletor de arquivo), e o Esc de lá cancelaria a resposta.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  function handleCaptionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    send();
  }

  if (!selected) return null;

  return (
    <div
      role="dialog"
      aria-label="Prévia do anexo"
      data-testid="attachment-preview"
      className="absolute inset-0 z-20 flex flex-col bg-bg"
    >
      <header className="flex items-center gap-md border-b border-neutral-300 px-lg py-sm">
        <button
          type="button"
          onClick={onClose}
          aria-label="Descartar anexos"
          className="flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-pill border-none bg-transparent font-body text-label text-neutral-700 hover:bg-neutral-200"
        >
          ×
        </button>
        <span className="min-w-0 flex-1 truncate font-body text-label font-semibold text-text">
          {selected.file.name}
        </span>
      </header>

      <SelectedFile key={selected.id} draft={selected} />

      <div className="flex flex-col gap-sm border-t border-neutral-300 px-lg py-md">
        <textarea
          ref={captionRef}
          rows={1}
          value={selected.caption}
          maxLength={MAX_CAPTION_LENGTH}
          disabled={selected.error !== null}
          onChange={(event) => onCaptionChange(selected.id, event.target.value)}
          onKeyDown={handleCaptionKeyDown}
          placeholder="Adicionar legenda"
          aria-label="Adicionar legenda"
          className={cn(
            'min-h-[36px] w-full resize-none rounded-md border border-neutral-300 bg-bg',
            'px-lg py-[9px] font-body text-label text-text outline-none',
            'placeholder:text-neutral-600 focus:border-accent disabled:cursor-not-allowed disabled:opacity-60',
          )}
        />

        <div className="flex items-center gap-sm">
          <ul
            aria-label="Arquivos a enviar"
            className="m-0 flex min-w-0 flex-1 gap-sm overflow-x-auto p-xs"
          >
            {items.map((item) => (
              <Thumbnail
                key={item.id}
                draft={item}
                selected={item.id === selected.id}
                onSelect={() => setSelectedId(item.id)}
                onRemove={() => remove(item.id)}
              />
            ))}
            <li className="flex list-none">
              <button
                type="button"
                onClick={() => addInputRef.current?.click()}
                aria-label="Adicionar arquivos"
                className="flex h-[56px] w-[56px] cursor-pointer items-center justify-center rounded-sm border-2 border-dashed border-neutral-400 bg-transparent font-body text-section text-neutral-600 hover:bg-neutral-100"
              >
                +
              </button>
              <input
                ref={addInputRef}
                type="file"
                multiple
                hidden
                accept={DOCUMENT_ACCEPT}
                data-testid="attachment-add-input"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  if (files.length > 0) onAdd(files);
                }}
              />
            </li>
          </ul>
          <Button onClick={send} disabled={!hasValid}>
            Enviar
          </Button>
        </div>
      </div>
    </div>
  );
}
