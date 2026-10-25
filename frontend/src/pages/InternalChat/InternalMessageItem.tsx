import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { internalMessageAuthorActionBlock, mediaCategoryOf } from '@crm-lab/shared';
import type { InternalMessage, InternalMessageAttachment, UserRole } from '@crm-lab/shared';
import { api, queryKeys } from '@/api';
import { cn } from '@/components/ui';
import { DateDisplay, ImageLightbox } from '@/components/shared';
import { AudioMessage, INBOX_BUBBLE_MAX_WIDTH, MessageEditBox } from '@/components/conversation';
import { DocumentCard } from '@/components/conversation/DocumentCard';
import { useAuthenticatedMedia } from '@/hooks';
import ProposalCard from '@/components/proposal/ProposalCard';
import { ApprovalActions } from './ApprovalActions';

/**
 * Uma mensagem do chat interno — WORKFLOWS.md §6.
 *
 * Três formas, como no inbox de atendimento: recebida · enviada (a sua) ·
 * sistema (o pedido de aprovação). A proposta anexada vira `ProposalCard`
 * clicável, que abre o Modal da Proposta (PAGES.md §6).
 *
 * A proposta anexada NÃO vem no payload da mensagem (o contrato só carrega o
 * id): ela é uma query própria em `queryKeys.proposal(id)` — a MESMA chave que
 * `approval.requested` / `approval.decided` invalidam, então o cartão e os
 * botões se atualizam sozinhos quando a decisão chega por WebSocket.
 */

export interface InternalMessageItemProps {
  message: InternalMessage;
  /** Id do usuário logado — define se a bolha é "enviada". */
  currentUserId: string | null;
  currentUserRole: UserRole | null;
  /** `#aprovacoes`: só lá os botões de decisão aparecem. */
  isApprovalsChannel: boolean;
  /**
   * Editar / Apagar para todos da AUTORA (CRMLAB-117, D-282). Os itens só
   * aparecem com handler e quando `internalMessageAuthorActionBlock` deixa
   * (autora, no prazo, texto para editar). `onEdit` devolve a Promise da
   * chamada: resolveu, sai da edição; rejeitou, continua editando.
   */
  onEdit?: (message: InternalMessage, content: string) => Promise<unknown>;
  onDelete?: (message: InternalMessage) => void;
}

type BubbleKind = 'received' | 'sent' | 'system';

const SHELL: Record<BubbleKind, string> = {
  received: 'self-start bg-surface rounded-md rounded-bl-sm px-[15px] py-[11px]',
  sent: 'self-end bg-accent-200 rounded-md rounded-br-sm px-[15px] py-[11px]',
  system:
    'self-center w-full bg-accent2-100 border border-accent2-300 rounded-md px-[15px] py-[11px]',
};

/** Só gestor/admin decide (SERVICES.md §6). A UI esconde, o servidor recusa. */
function canDecide(role: UserRole | null): boolean {
  return role === 'manager' || role === 'admin';
}

function AttachedProposal({
  proposalId,
  showActions,
}: {
  proposalId: string;
  showActions: boolean;
}) {
  const proposalQuery = useQuery({
    queryKey: queryKeys.proposal(proposalId),
    queryFn: () => api.proposals.get(proposalId),
  });

  if (proposalQuery.isPending) {
    return (
      <p role="status" className="m-0 font-body text-caption text-neutral-600">
        Carregando proposta…
      </p>
    );
  }

  if (proposalQuery.isError || !proposalQuery.data) {
    return (
      <p className="m-0 font-body text-caption text-neutral-600">
        Não foi possível carregar a proposta anexada.
      </p>
    );
  }

  const proposal = proposalQuery.data;

  return (
    <div className="flex flex-col gap-sm">
      <ProposalCard proposal={proposal} />
      {showActions && proposal.approvalStatus === 'pending' && (
        <ApprovalActions proposal={proposal} />
      )}
    </div>
  );
}

/**
 * Anexo da mensagem (CRMLAB-101, D-271). Imagem: miniatura buscada com token
 * (`GET .../attachments/:id` exige Authorization — `<img src>` cru daria 401),
 * clique abre o `ImageLightbox`. Áudio (CRMLAB-109): `AudioMessage` do
 * atendimento, que também busca com token. Qualquer outro tipo: `DocumentCard` com
 * `messageType="doc"`, que sempre BAIXA com o nome original (inclusive PDF).
 */
function MessageAttachment({
  attachment,
  title,
}: {
  attachment: InternalMessageAttachment;
  title: string;
}) {
  const category = mediaCategoryOf(attachment.mimeType);
  const isImage = category === 'image';
  const media = useAuthenticatedMedia(isImage ? attachment.url : null);
  const [open, setOpen] = useState(false);

  if (category === 'audio') return <AudioMessage url={attachment.url} />;

  if (!isImage) {
    return (
      <DocumentCard
        url={attachment.url}
        messageType="doc"
        media={{
          fileName: attachment.fileName,
          fileSize: attachment.byteSize,
          mimeType: attachment.mimeType,
          durationSec: null,
          pageCount: null,
          thumbnail: null,
        }}
      />
    );
  }

  if (!media.objectUrl) {
    return (
      <span className="text-caption text-neutral-600">
        {media.isLoading ? 'Carregando imagem…' : 'Não foi possível carregar a imagem'}
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Ampliar imagem ${attachment.fileName}`}
        className="cursor-pointer self-start rounded-md border-none bg-transparent p-0"
      >
        <img
          src={media.objectUrl}
          alt={attachment.fileName}
          data-testid="internal-attachment-thumbnail"
          className="max-h-[300px] max-w-full rounded-md object-cover"
        />
      </button>
      {open && (
        <ImageLightbox
          src={media.objectUrl}
          fileName={attachment.fileName}
          title={title}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Setinha + menu da mensagem (CRMLAB-117): Editar · Apagar para todos. Mesmo
 * padrão do `MessageMenu` do atendimento (clique-fora + Esc, sem biblioteca).
 * Só é montado quando há pelo menos um item.
 */
function AuthorMenu({
  onStartEdit,
  onDelete,
}: {
  onStartEdit?: () => void;
  onDelete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const item =
    'w-full cursor-pointer border-none bg-transparent px-md py-xs text-left font-body text-label text-text hover:bg-accent-100';

  return (
    <div ref={ref} className="absolute right-xs top-xs z-10">
      <button
        type="button"
        aria-label="Ações da mensagem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex cursor-pointer items-center justify-center rounded-pill border-none bg-transparent px-xs',
          'font-body text-caption text-neutral-600 hover:bg-neutral-200',
          'opacity-0 focus:opacity-100 group-hover:opacity-100',
          open && 'opacity-100',
        )}
      >
        ⌄
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-xs w-max min-w-full rounded-md border border-neutral-200 bg-surface py-xs shadow-md"
        >
          {onStartEdit && (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                onStartEdit();
              }}
            >
              Editar
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                if (window.confirm('Apagar para todos?')) onDelete();
              }}
            >
              Apagar para todos
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function InternalMessageItem({
  message,
  currentUserId,
  currentUserRole,
  isApprovalsChannel,
  onEdit,
  onDelete,
}: InternalMessageItemProps) {
  const [editing, setEditing] = useState(false);
  const kind: BubbleKind = message.isSystem
    ? 'system'
    : message.senderId !== null && message.senderId === currentUserId
      ? 'sent'
      : 'received';
  // Apagada pela autora (D-282): a API já mandou sem conteúdo; o balão só avisa.
  const isDeleted = Boolean(message.deletedAt);

  // D-282: a regra é a mesma da API (shared). Avaliada a cada render — o item
  // some quando o prazo passa.
  const canEdit =
    Boolean(onEdit && currentUserId) &&
    internalMessageAuthorActionBlock(message, 'edit', currentUserId ?? '') === null;
  const canDelete =
    Boolean(onDelete && currentUserId) &&
    internalMessageAuthorActionBlock(message, 'delete', currentUserId ?? '') === null;
  const hasMenu = !editing && (canEdit || canDelete);

  const shell = cn(
    'group relative flex min-w-0 flex-col gap-xs font-body text-label text-text',
    SHELL[kind],
  );
  const style = { maxWidth: kind === 'system' ? undefined : INBOX_BUBBLE_MAX_WIDTH };
  const meta = (
    <span className="flex items-baseline gap-sm font-body text-micro text-neutral-600">
      <span className="truncate">{message.senderName}</span>
      <DateDisplay value={message.createdAt} variant="absolute" />
      {!isDeleted && message.editedAt && (
        <span data-testid="internal-message-edited">Editada</span>
      )}
    </span>
  );

  if (isDeleted) {
    return (
      <article
        data-testid="internal-message"
        data-kind={kind}
        data-deleted="true"
        style={style}
        className={shell}
      >
        <p className="m-0 italic text-neutral-600">🚫 Mensagem apagada</p>
        {meta}
      </article>
    );
  }

  return (
    <article data-testid="internal-message" data-kind={kind} style={style} className={shell}>
      {hasMenu && (
        <AuthorMenu
          {...(canEdit ? { onStartEdit: () => setEditing(true) } : {})}
          {...(canDelete && onDelete ? { onDelete: () => onDelete(message) } : {})}
        />
      )}

      {editing && onEdit ? (
        <MessageEditBox
          initial={message.content}
          onSave={(content) => onEdit(message, content)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        message.content !== '' && (
          <p className="m-0 whitespace-pre-wrap break-words">{message.content}</p>
        )
      )}

      {message.attachment && (
        <MessageAttachment attachment={message.attachment} title={message.senderName} />
      )}

      {message.attachedProposalId !== null && (
        <AttachedProposal
          proposalId={message.attachedProposalId}
          showActions={isApprovalsChannel && canDecide(currentUserRole)}
        />
      )}

      {meta}
    </article>
  );
}
