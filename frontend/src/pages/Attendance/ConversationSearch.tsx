import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, queryKeys, staleTimes } from '@/api';
import { SearchInput, cn } from '@/components/ui';
import { DateDisplay } from '@/components/shared';
import { isSearchableTerm } from '@/lib/search-snippet';
import { SearchSnippet } from './SearchSnippet';

/**
 * Busca dentro da conversa aberta (CRMLAB-68, D-228/D-230) — a lupa do
 * cabeçalho, padrão WhatsApp Web.
 *
 * Campo + "N de M" + setas: ↑ vai para a ocorrência mais ANTIGA, ↓ para a mais
 * nova (a lista vem da mais nova para a mais antiga); Enter = ↑, Esc fecha.
 * Abaixo, os resultados (data + trecho). Escolher um resultado chama `onGoTo`:
 * quem monta o painel rola até a mensagem ou, se ela não está carregada,
 * reabre a conversa em volta dela (`around`).
 *
 * Local da tela e dono da própria query: só existe com a lupa aberta.
 */

/** Uma consulta basta: acima disso, o "N de M" mostra "100+". */
export const IN_CONVERSATION_LIMIT = 100;

export interface ConversationSearchProps {
  conversationId: string;
  onGoTo: (messageId: string) => void;
  onClose: () => void;
}

export function ConversationSearch({ conversationId, onGoTo, onClose }: ConversationSearchProps) {
  const [term, setTerm] = useState('');
  const [index, setIndex] = useState<number | null>(null);
  const searchable = isSearchableTerm(term);
  const query = { q: term.trim(), limit: IN_CONVERSATION_LIMIT };

  const results = useQuery({
    queryKey: queryKeys.messageSearch({ ...query, conversationId }),
    queryFn: () => api.conversations.searchInConversation(conversationId, query),
    enabled: searchable,
    staleTime: staleTimes.conversations,
  });

  const hits = searchable ? (results.data?.results ?? []) : [];
  const total = results.data?.pagination.total ?? 0;

  // Termo novo: nenhuma ocorrência escolhida ainda.
  useEffect(() => setIndex(null), [term]);

  function go(next: number): void {
    const hit = hits[next];
    if (!hit) return;
    setIndex(next);
    onGoTo(hit.messageId);
  }

  /** ↑ = mais antiga (índice maior), ↓ = mais nova. */
  const older = () => go(index === null ? 0 : Math.min(hits.length - 1, index + 1));
  const newer = () => go(index === null ? 0 : Math.max(0, index - 1));

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (
      event.key === 'ArrowUp' ||
      // Enter só no campo: num resultado focado, Enter é o clique dele.
      (event.key === 'Enter' && event.target instanceof HTMLInputElement)
    ) {
      event.preventDefault();
      older();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      newer();
    }
  }

  const counter =
    !searchable || results.isPending
      ? ''
      : hits.length === 0
        ? 'Nenhum resultado'
        : `${index === null ? 0 : index + 1} de ${total > hits.length ? `${hits.length}+` : hits.length}`;

  const arrow = cn(
    'flex h-[28px] w-[28px] flex-[0_0_28px] cursor-pointer items-center justify-center',
    'rounded-pill border-none bg-transparent font-body text-label text-neutral-700 hover:bg-neutral-200',
    'disabled:cursor-default disabled:opacity-40',
  );

  return (
    <div
      role="search"
      aria-label="Buscar nesta conversa"
      onKeyDown={onKeyDown}
      className="flex flex-col border-b border-neutral-300 bg-surface"
    >
      <div className="flex items-center gap-sm px-lg py-sm">
        <div className="min-w-0 flex-1">
          <SearchInput
            placeholder="Buscar nesta conversa"
            aria-label="Buscar nesta conversa"
            onSearch={setTerm}
          />
        </div>
        <span
          data-testid="conversation-search-counter"
          className="flex-[0_0_auto] font-body text-caption text-neutral-600"
        >
          {counter}
        </span>
        <button
          type="button"
          className={arrow}
          onClick={older}
          disabled={hits.length === 0 || index === hits.length - 1}
          aria-label="Ocorrência anterior (mais antiga)"
        >
          ↑
        </button>
        <button
          type="button"
          className={arrow}
          onClick={newer}
          disabled={hits.length === 0 || index === null || index === 0}
          aria-label="Próxima ocorrência (mais nova)"
        >
          ↓
        </button>
        <button type="button" className={arrow} onClick={onClose} aria-label="Fechar busca">
          ×
        </button>
      </div>

      {searchable && results.isError && (
        <p role="alert" className="m-0 px-lg pb-sm font-body text-caption text-accent-700">
          Não foi possível buscar nesta conversa.
        </p>
      )}

      {hits.length > 0 && (
        <ul
          aria-label="Resultados da busca"
          className="m-0 flex max-h-[200px] list-none flex-col overflow-y-auto p-0 pb-xs"
        >
          {hits.map((hit, position) => (
            <li key={hit.messageId}>
              <button
                type="button"
                data-testid="conversation-search-result"
                aria-current={position === index ? 'true' : undefined}
                onClick={() => go(position)}
                className={cn(
                  'flex w-full min-w-0 cursor-pointer flex-col gap-xs border-none px-lg py-xs text-left font-body',
                  position === index ? 'bg-accent-100' : 'bg-transparent hover:bg-neutral-100',
                )}
              >
                <span className="text-micro text-neutral-600">
                  <DateDisplay value={hit.createdAt} variant="absolute" />
                </span>
                <span className="truncate text-caption text-text">
                  <SearchSnippet content={hit.content} term={term} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
