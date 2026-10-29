import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ListPatientsQuery, PatientListItem } from '@crm-lab/shared';
import { api, queryKeys, staleTimes } from '@/api';
import { SearchInput } from '@/components/ui';
import { formatBrazilianPhone } from '@/lib/phone-suggestion';
import { SEARCH_MIN_LENGTH } from '@/lib/search-term';

const MAX_RESULTS = 6;

export interface ContactSearchProps {
  /** Contato escolhido — a Nova conversa preenche o telefone com ele. */
  onPick: (patient: PatientListItem) => void;
}

/**
 * Busca de contato da "Nova conversa" (CRMLAB-121, D-287): nome, CPF ou
 * telefone, pela MESMA busca da tela de Contatos (`GET /patients?search=`,
 * D-060). O servidor já esconde inativo e aplica o recorte da atendente —
 * contato sem conversa aparece para todas. Anonimizado (LGPD, D-063) sai
 * aqui: não há com quem conversar.
 */
export function ContactSearch({ onPick }: ContactSearchProps) {
  const [term, setTerm] = useState('');
  /** Remonta o campo (não controlado) para limpá-lo depois da escolha. */
  const [resetKey, setResetKey] = useState(0);
  const enabled = term.length >= SEARCH_MIN_LENGTH;
  const filters: ListPatientsQuery = { search: term, limit: MAX_RESULTS, sortBy: 'name', order: 'asc' };

  const results = useQuery({
    queryKey: queryKeys.patients(filters),
    // `signal`: o termo novo cancela o pedido do anterior (CRMLAB-125).
    queryFn: ({ signal }) => api.patients.list(filters, { signal }),
    staleTime: staleTimes.patients,
    enabled,
  });

  const contacts = (results.data?.patients ?? []).filter((p) => p.anonymizedAt === null);

  return (
    <div className="flex flex-col gap-xs">
      <span className="font-body text-caption font-semibold text-text">Buscar contato</span>
      <SearchInput
        key={resetKey}
        placeholder="Nome, CPF ou telefone"
        aria-label="Buscar contato"
        onSearch={(value) => setTerm(value.trim())}
      />
      {enabled && (
        <div aria-live="polite">
          {results.isLoading ? (
            <p className="font-body text-caption text-neutral-600">Buscando…</p>
          ) : contacts.length === 0 ? (
            <p className="font-body text-caption text-neutral-600">
              Nenhum contato encontrado. Digite o telefone abaixo.
            </p>
          ) : (
            <ul className="flex flex-col rounded-md border border-neutral-200" aria-label="Contatos">
              {contacts.map((contact) => (
                <li key={contact.id} className="border-b border-neutral-200 last:border-b-0">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-md px-sm py-xs text-left font-body text-body text-text hover:bg-neutral-100"
                    onClick={() => {
                      onPick(contact);
                      setTerm('');
                      setResetKey((key) => key + 1);
                    }}
                  >
                    <span className="truncate font-semibold">
                      {contact.name ?? 'Sem nome cadastrado'}
                    </span>
                    <span className="whitespace-nowrap text-caption tabular-nums text-neutral-600">
                      {formatBrazilianPhone(contact.phone)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
