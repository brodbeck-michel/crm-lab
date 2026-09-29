import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MessageContact } from '@crm-lab/shared';
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
 * telefone, e "Conversar", que reaproveita a Nova conversa (CRMLAB-50, D-175)
 * com o número preenchido — o servidor reaproveita a conversa que já existe
 * naquele número ou cria uma. Ao iniciar, a tela navega para
 * `/attendance?conversationId=` (o Atendimento relê esse parâmetro a cada
 * navegação, D-240), sem precisar de prop atravessando o painel.
 */
export function ContactCard({ contacts }: ContactCardProps) {
  const navigate = useNavigate();
  const [startWith, setStartWith] = useState<string | null>(null);

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
              onClick={() => setStartWith(contact.phone)}
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
          onStarted={(conversationId) => navigate(`/attendance?conversationId=${conversationId}`)}
        />
      )}
    </div>
  );
}
