import type { MessageSearchHit } from '@crm-lab/shared';
import { DateDisplay } from '@/components/shared';
import { SearchSnippet } from './SearchSnippet';

/**
 * Bloco "Mensagens" da busca da coluna 1 (CRMLAB-68, D-228) — a mesma
 * digitação que acha conversa por nome/telefone também acha a mensagem pelo
 * CONTEÚDO (`GET /conversations/search/messages`). Cada linha: nome do
 * paciente, data e o trecho com o termo em destaque. O clique abre a conversa
 * já na mensagem (`around`, D-230).
 *
 * O servidor já recorta por papel e tenant e nunca devolve mensagem apagada.
 */
export interface MessageResultsProps {
  /** Termo em vigor. Vazio = o bloco não existe. */
  term: string;
  hits: MessageSearchHit[];
  isLoading: boolean;
  isError: boolean;
  onOpen: (hit: MessageSearchHit) => void;
}

export function MessageResults({ term, hits, isLoading, isError, onOpen }: MessageResultsProps) {
  if (term.length === 0) return null;

  return (
    <section aria-label="Mensagens encontradas" className="flex flex-col gap-xs pt-sm">
      <h2 className="m-0 px-sm font-heading text-micro font-semibold uppercase text-neutral-600">
        Mensagens
      </h2>

      {isLoading && (
        <p role="status" className="m-0 px-sm py-sm text-caption text-neutral-600">
          Buscando mensagens…
        </p>
      )}

      {!isLoading && isError && (
        <p role="alert" className="m-0 px-sm py-sm text-caption text-accent-700">
          Não foi possível buscar nas mensagens.
        </p>
      )}

      {!isLoading && !isError && hits.length === 0 && (
        <p className="m-0 px-sm py-sm text-caption text-neutral-600">
          Nenhuma mensagem com esse termo.
        </p>
      )}

      {!isLoading &&
        !isError &&
        hits.map((hit) => (
          <button
            key={hit.messageId}
            type="button"
            data-testid="message-result"
            onClick={() => onOpen(hit)}
            className="flex w-full min-w-0 cursor-pointer flex-col gap-xs rounded-md border-none bg-transparent px-sm py-sm text-left font-body transition-colors hover:bg-accent-100"
          >
            <span className="flex items-baseline gap-sm">
              <span className="min-w-0 flex-1 truncate text-label font-semibold text-text">
                {hit.patientName ?? hit.patientPhone}
              </span>
              <span className="flex-[0_0_auto] text-micro text-neutral-600">
                <DateDisplay value={hit.createdAt} variant="relative" />
              </span>
            </span>
            <span className="truncate text-caption text-neutral-700">
              <SearchSnippet content={hit.content} term={term} />
            </span>
          </button>
        ))}
    </section>
  );
}
