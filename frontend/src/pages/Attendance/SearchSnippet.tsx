import { highlightParts, searchSnippet } from '@/lib/search-snippet';

/**
 * Trecho de mensagem com o termo em destaque (CRMLAB-68, D-228 item 6) — o
 * mesmo nos dois lugares que mostram resultado de busca: o bloco "Mensagens"
 * da coluna 1 e a busca dentro da conversa. `<mark>` com tokens; o texto vem
 * cru da API e nunca vira HTML.
 */
export function SearchSnippet({ content, term }: { content: string; term: string }) {
  return (
    <>
      {highlightParts(searchSnippet(content, term), term).map((part, index) =>
        part.match ? (
          <mark
            key={index}
            data-testid="search-highlight"
            className="bg-transparent font-bold text-accent2-700"
          >
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
