import type { ReactNode } from 'react';
import { useUIStore } from '@/stores';
import { cn } from '@/components/ui';

/**
 * InboxLayout — 3 colunas: `336px | flex 1 min 440px | 316px recolhível`
 * (COMPONENTS.md `layout/` + DESIGN_TOKENS.md "Inbox").
 *
 * Regras de Largura aplicadas:
 *  1. a coluna flexível tem `min-width` EXPLÍCITO (440px);
 *  2. em tela estreita a LINHA ganha `overflow-x` — as colunas não colapsam
 *     (é justamente o bug do protótipo que a regra existe para evitar);
 *  3. a raiz tem altura EXATA de viewport (`h-screen`), não `min-h-screen`.
 *     Com altura mínima a caixa cresce com o conteúdo, o `overflow-y-auto` das
 *     colunas nunca entra em ação (altura indefinida não tem do que estourar) e
 *     quem rola é o DOCUMENTO — o composer da conversa saía da tela e exigia
 *     rolar a página inteira para escrever. Cada coluna rola por dentro.
 */

export interface InboxLayoutProps {
  /** Coluna 1 — lista de conversas (336px). */
  list: ReactNode;
  /**
   * `aria-label` da coluna 1. Default `"Conversas"` (Atendimento); o Chat
   * Interno reaproveita o layout com uma lista de CANAIS, e o rótulo precisa
   * dizer isso.
   */
  listLabel?: string;
  /** Coluna 2 — conversa aberta (flex, mínimo 440px). */
  conversation: ReactNode;
  /** Coluna 3 — contexto do paciente (316px, recolhível). */
  context?: ReactNode;
  /** Sobrepõe o `contextPanelOpen` do `useUIStore` (útil em teste/preview). */
  contextOpen?: boolean;
  className?: string;
}

export const INBOX_LIST_WIDTH = 336;
export const INBOX_CONVERSATION_MIN_WIDTH = 440;
export const INBOX_CONTEXT_WIDTH = 316;

export function InboxLayout({
  list,
  listLabel = 'Conversas',
  conversation,
  context,
  contextOpen,
  className,
}: InboxLayoutProps) {
  const storeOpen = useUIStore((state) => state.contextPanelOpen);
  const open = contextOpen ?? storeOpen;

  return (
    <div
      data-testid="inbox-layout"
      className={cn('flex h-screen w-full overflow-x-auto bg-bg', className)}
    >
      <section
        data-testid="inbox-list"
        aria-label={listLabel}
        style={{ flex: `0 0 ${INBOX_LIST_WIDTH}px`, width: INBOX_LIST_WIDTH }}
        className="flex min-h-0 flex-col overflow-y-auto border-r border-neutral-300 bg-surface"
      >
        {list}
      </section>

      <section
        data-testid="inbox-conversation"
        aria-label="Conversa"
        style={{ flex: '1 1 0%', minWidth: INBOX_CONVERSATION_MIN_WIDTH }}
        className="flex min-h-0 flex-col"
      >
        {conversation}
      </section>

      {open && context && (
        <aside
          data-testid="inbox-context"
          aria-label="Contexto do paciente"
          style={{ flex: `0 0 ${INBOX_CONTEXT_WIDTH}px`, width: INBOX_CONTEXT_WIDTH }}
          className="flex min-h-0 flex-col overflow-y-auto border-l border-neutral-300 bg-surface"
        >
          {context}
        </aside>
      )}
    </div>
  );
}
