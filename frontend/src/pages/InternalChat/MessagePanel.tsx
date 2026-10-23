import { useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import type { Channel, InternalMessage, UserRole } from '@crm-lab/shared';
import { Button, cn } from '@/components/ui';
import { EmptyState } from '@/components/shared';
import {
  AttachmentPreview,
  Composer,
  createAttachmentDraft,
  dragHasFiles,
  filesFromDataTransfer,
} from '@/components/conversation';
import type { AttachmentDraft, RecordedAudio } from '@/components/conversation';
import { InternalMessageItem } from './InternalMessageItem';

/**
 * Coluna 2 do Chat Interno — cabeçalho do canal · mensagens · composer.
 * Reaproveita o `Composer` do inbox (Enter envia, Shift+Enter quebra linha).
 */

export interface MessagePanelProps {
  channel: Channel | null;
  messages: InternalMessage[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onSend: (content: string) => void | Promise<unknown>;
  sending: boolean;
  currentUserId: string | null;
  currentUserRole: UserRole | null;
  /** Ainda há mensagens anteriores no servidor. */
  hasOlderMessages: boolean;
  onLoadOlder: () => void;
  /**
   * Arquivos da prévia, já sem os inválidos (CRMLAB-101, D-271). Sem handler,
   * nem clipe, nem colar, nem soltar arquivo.
   */
  onSendAttachments?: (items: { file: File; caption: string }[]) => void | Promise<unknown>;
  /** Recado de voz (CRMLAB-109). Sem handler, o microfone do Composer não aparece. */
  onSendAudio?: (audio: RecordedAudio) => Promise<unknown>;
  /** × do cabeçalho (CRMLAB-109): tira a seleção, como o "Fechar conversa" do atendimento. */
  onClose?: () => void;
}

/** Chave do canal em que o sistema posta os pedidos (WORKFLOWS.md §3 e §6). */
export const APPROVALS_CHANNEL_KEY = 'aprovacoes';

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center">{children}</div>;
}

export function MessagePanel({
  channel,
  messages,
  isLoading,
  isError,
  onRetry,
  onSend,
  sending,
  currentUserId,
  currentUserRole,
  hasOlderMessages,
  onLoadOlder,
  onSendAttachments,
  onSendAudio,
  onClose,
}: MessagePanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const channelId = channel?.id ?? null;

  // Prévia de anexos (D-271, mesmo componente do atendimento, D-232): presa ao
  // canal em que abriu — trocar de canal descarta.
  const [preview, setPreview] = useState<{ channelId: string; items: AttachmentDraft[] } | null>(
    null,
  );
  const drafts = preview && preview.channelId === channelId ? preview.items : null;
  const closePreview = (): void => setPreview(null);

  function openPreview(files: File[]): void {
    if (channelId === null || files.length === 0) return;
    const added = files.map(createAttachmentDraft);
    setPreview((current) => ({
      channelId,
      items: current && current.channelId === channelId ? [...current.items, ...added] : added,
    }));
  }

  function updateDrafts(update: (items: AttachmentDraft[]) => AttachmentDraft[]): void {
    setPreview((current) => (current ? { ...current, items: update(current.items) } : current));
  }

  function sendPreview(): void {
    const valid = (drafts ?? []).filter((item) => item.error === null);
    if (valid.length === 0 || !onSendAttachments) return;
    void onSendAttachments(
      valid.map((item) => ({ file: item.file, caption: item.caption.trim() })),
    );
    closePreview();
  }

  // Soltar arquivo (bônus do card): contador porque cada filho dispara enter/leave.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const acceptsFiles = Boolean(onSendAttachments);

  function handleDragEnter(event: DragEvent<HTMLDivElement>): void {
    if (!acceptsFiles || !dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!acceptsFiles || !dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (!dragging) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    dragDepth.current = 0;
    setDragging(false);
    if (!acceptsFiles) return;
    const files = filesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    openPreview(files);
  }

  /** Mensagem nova rola para o fim. */
  const lastId = messages.at(-1)?.id ?? null;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lastId, channel?.id]);

  if (isError) {
    return (
      <Centered>
        <EmptyState
          message="Não foi possível carregar o canal"
          hint="A conexão pode ter caído no meio do caminho."
          action={
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Tentar novamente
            </Button>
          }
        />
      </Centered>
    );
  }

  if (isLoading) {
    return (
      <Centered>
        <p role="status" className="m-0 font-body text-caption text-neutral-600">
          Carregando mensagens…
        </p>
      </Centered>
    );
  }

  if (!channel) {
    return (
      <Centered>
        <EmptyState
          message="Selecione um canal"
          hint="À esquerda ficam os canais da equipe e as mensagens diretas."
        />
      </Centered>
    );
  }

  const isApprovalsChannel = channel.key === APPROVALS_CHANNEL_KEY;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <header className="flex items-center gap-md border-b border-neutral-300 px-lg py-md">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-body text-label font-semibold text-text">
            {channel.name}
          </span>
          <span className="truncate font-body text-caption text-neutral-600">
            {isApprovalsChannel
              ? 'Pedidos de aprovação de desconto acima da alçada'
              : channel.kind === 'dm'
                ? 'Mensagem direta'
                : 'Canal da equipe'}
          </span>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar conversa"
            className={cn(
              'flex h-[28px] w-[28px] flex-[0_0_28px] cursor-pointer items-center justify-center',
              'rounded-pill border-none bg-transparent font-body text-neutral-700 hover:bg-neutral-200',
            )}
          >
            ×
          </button>
        )}
      </header>

      <div
        data-testid="internal-drop-area"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="relative flex min-h-0 flex-1 flex-col"
      >
        <div
          ref={scrollRef}
          data-testid="internal-message-scroll"
          className="flex min-h-0 flex-1 flex-col gap-sm overflow-y-auto px-lg py-lg"
        >
          {hasOlderMessages && (
            <div className="flex flex-[0_0_auto] justify-center pb-sm">
              <Button variant="secondary" size="sm" onClick={onLoadOlder}>
                Carregar mensagens anteriores
              </Button>
            </div>
          )}

          {messages.length === 0 ? (
            <EmptyState
              message="Nenhuma mensagem ainda"
              hint="Escreva a primeira mensagem deste canal."
            />
          ) : (
            messages.map((message) => (
              <InternalMessageItem
                key={message.id}
                message={message}
                currentUserId={currentUserId}
                currentUserRole={currentUserRole}
                isApprovalsChannel={isApprovalsChannel}
              />
            ))
          )}
        </div>

        {dragging && !drafts && (
          <div
            data-testid="drop-zone"
            className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-bg p-lg"
          >
            <span className="flex h-full w-full items-center justify-center rounded-md border-2 border-dashed border-accent font-body text-label font-semibold text-accent-800">
              Solte o arquivo aqui
            </span>
          </div>
        )}

        {drafts && (
          <AttachmentPreview
            items={drafts}
            onCaptionChange={(id, caption) =>
              updateDrafts((items) =>
                items.map((item) => (item.id === id ? { ...item, caption } : item)),
              )
            }
            onRemove={(id) => updateDrafts((items) => items.filter((item) => item.id !== id))}
            onAdd={openPreview}
            onSend={sendPreview}
            onClose={closePreview}
          />
        )}
      </div>

      <Composer
        onSend={onSend}
        sending={sending}
        placeholder="Escreva para a equipe"
        {...(onSendAttachments ? { onPickFiles: openPreview } : {})}
        {...(onSendAudio ? { onSendAudio } : {})}
      />
    </div>
  );
}
