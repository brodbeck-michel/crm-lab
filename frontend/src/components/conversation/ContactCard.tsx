import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { normalizeBrazilianPhone, type MessageContact } from '@crm-lab/shared';
import { api, isApiError, queryScopes } from '@/api';
import { useToast } from '@/components/ui';
import { useApiErrorHandler } from '@/hooks';
import { initials } from '@/lib/format';
import { NewConversationModal } from '@/pages/Attendance/NewConversationModal';

export interface ContactCardProps {
  contacts: MessageContact[];
}

/** `+5548999991234` → `(48) 99999-1234`; outro formato sai como veio. */
export function formatContactPhone(phone: string): string {
  const br = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(phone);
  return br ? `(${br[1]}) ${br[2]}-${br[3]}` : phone;
}

/**
 * ContactCard — contato compartilhado (CRMLAB-70, D-236 item 7): nome e
 * telefone, e "Conversar". O número que JÁ tem conversa abre direto
 * (`POST /conversations/whatsapp/open`, sem mensagem — encerrada reabre para
 * quem clicou); só o número sem conversa (404) cai na Nova conversa
 * (CRMLAB-50, D-175) com o telefone preenchido. De outra atendente (409):
 * toast com o nome, sem abrir. A tela navega para `/attendance?conversationId=`
 * (o Atendimento relê esse parâmetro a cada navegação, D-240), sem prop
 * atravessando o painel.
 */
export function ContactCard({ contacts }: ContactCardProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const handleApiError = useApiErrorHandler();
  const [startWith, setStartWith] = useState<string | null>(null);

  const goTo = (conversationId: string) => navigate(`/attendance?conversationId=${conversationId}`);

  const open = useMutation({
    mutationFn: (phone: string) => api.conversations.openWhatsApp({ phone }),
    onSuccess: async (conversation) => {
      await queryClient.invalidateQueries({ queryKey: queryScopes.conversations });
      goTo(conversation.id);
    },
    onError: (error, phone) => {
      if (isApiError(error) && error.code === 'NOT_FOUND') {
        setStartWith(phone);
        return;
      }
      if (isApiError(error) && error.code === 'CONVERSATION_ALREADY_ASSIGNED') {
        const owner = error.details?.assignedToName;
        toast(
          `Este número já está em atendimento com ${
            typeof owner === 'string' && owner.length > 0 ? owner : 'outra pessoa'
          }.`,
          { tone: 'attention' },
        );
        return;
      }
      handleApiError(error);
    },
  });

  const converse = (phone: string) => {
    // Fora do padrão BR a API recusaria: o modal mostra o motivo.
    const normalized = normalizeBrazilianPhone(phone);
    if (normalized === null) setStartWith(phone);
    else open.mutate(normalized);
  };

  return (
    <div data-testid="contact-card" className="flex min-w-0 flex-col gap-xs">
      {contacts.map((contact, index) => (
        <div
          key={`${contact.name}-${index}`}
          className="flex min-w-0 items-center gap-sm rounded-md border border-neutral-200 bg-surface px-sm py-xs font-body"
        >
          <span
            aria-hidden="true"
            className="flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-pill bg-accent-100 text-caption font-semibold text-accent-800"
          >
            {initials(contact.name) || '👤'}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-label font-semibold text-text">{contact.name}</span>
            <span className="text-caption text-neutral-600">
              {contact.phone ? formatContactPhone(contact.phone) : 'Sem telefone'}
            </span>
          </span>
          {contact.phone && (
            <button
              type="button"
              aria-label={`Conversar com ${contact.name}`}
              disabled={open.isPending}
              onClick={() => contact.phone && converse(contact.phone)}
              className="shrink-0 cursor-pointer rounded-pill border border-accent-300 bg-transparent px-sm font-body text-caption font-semibold text-accent-700 hover:bg-accent-100"
            >
              Conversar
            </button>
          )}
        </div>
      ))}
      {startWith !== null && (
        <NewConversationModal
          initialPhone={startWith}
          onClose={() => setStartWith(null)}
          onStarted={goTo}
        />
      )}
    </div>
  );
}
