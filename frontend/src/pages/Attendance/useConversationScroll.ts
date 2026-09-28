import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Message } from '@crm-lab/shared';

/**
 * Rolagem da conversa no padrão WhatsApp Web — CRMLAB-71, D-238/D-239.
 *
 * - Abrir a conversa: rola até a faixa de não lidas, se houver; senão, ao fim.
 * - Mensagem nova perto do fim (ou logo depois de a atendente enviar): desce.
 *   Longe do fim: a tela NÃO se mexe e o contador do botão ↓ sobe.
 * - Qualquer outra mudança (histórico carregado em cima, mensagem antiga que
 *   saiu do topo quando o TanStack refez as páginas): a mensagem que estava sob
 *   os olhos fica no mesmo lugar. A âncora é a primeira linha visível
 *   (`data-anchor-id`) e a distância dela ao topo da área rolável.
 * - Perto do topo, com histórico a carregar: pede a página anterior.
 *
 * A lista precisa de `position: relative` (o `offsetTop` das linhas é medido
 * a partir dela) e de `overflow-anchor: none` (senão o navegador compensa o
 * deslocamento também, e ele conta duas vezes).
 */

/** Até aqui do fim conta como "no fim": mensagem nova desce, botão ↓ some. */
export const NEAR_BOTTOM_PX = 80;
/** A menos disso do topo, pede o histórico anterior. */
export const NEAR_TOP_PX = 200;
/** Folga acima da faixa de não lidas quando a conversa abre nela. */
const DIVIDER_OFFSET_PX = 16;

interface Anchor {
  id: string;
  offset: number;
}

export interface ConversationScrollOptions {
  scrollRef: RefObject<HTMLDivElement>;
  messages: Message[];
  conversationId: string | null;
  /** Faixa "N mensagens não lidas" — destino da rolagem ao abrir. */
  dividerRef: RefObject<HTMLElement>;
  /** Ainda há histórico E nada está sendo buscado agora (D-238 item 4). */
  canLoadOlder: boolean;
  onLoadOlder: () => void;
}

export interface ConversationScroll {
  /** Longe do fim: mostra o botão ↓. */
  showJumpButton: boolean;
  /** Mensagens que chegaram enquanto a atendente lia mais acima. */
  newCount: number;
  onScroll: () => void;
  jumpToBottom: (behavior?: ScrollBehavior) => void;
  /** A próxima mensagem nova desce a tela, esteja onde estiver (envio próprio). */
  stickOnNextMessage: () => void;
}

function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function rows(element: HTMLElement): HTMLElement[] {
  return Array.from(element.querySelectorAll<HTMLElement>('[data-anchor-id]'));
}

function readAnchor(element: HTMLElement): Anchor | null {
  const top = element.scrollTop;
  const row = rows(element).find((candidate) => candidate.offsetTop + candidate.offsetHeight > top);
  const id = row?.dataset.anchorId;
  return row && id ? { id, offset: row.offsetTop - top } : null;
}

export function useConversationScroll({
  scrollRef,
  messages,
  conversationId,
  dividerRef,
  canLoadOlder,
  onLoadOlder,
}: ConversationScrollOptions): ConversationScroll {
  const [showJumpButton, setShowJumpButton] = useState(false);
  const [newCount, setNewCount] = useState(0);

  const atBottomRef = useRef(true);
  const anchorRef = useRef<Anchor | null>(null);
  const lastIdRef = useRef<string | null>(null);
  const conversationRef = useRef<string | null>(null);
  const stickRef = useRef(false);
  // Lidos no handler de rolagem sem recriá-lo a cada render.
  const loadRef = useRef({ canLoadOlder, onLoadOlder });
  loadRef.current = { canLoadOlder, onLoadOlder };

  const syncPosition = useCallback((element: HTMLElement) => {
    const atBottom = distanceFromBottom(element) <= NEAR_BOTTOM_PX;
    atBottomRef.current = atBottom;
    setShowJumpButton(!atBottom);
    if (atBottom) setNewCount(0);
    anchorRef.current = readAnchor(element);
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const lastId = messages.at(-1)?.id ?? null;
    const opened = conversationRef.current !== conversationId || lastIdRef.current === null;
    const appended = !opened && lastId !== lastIdRef.current;

    if (opened) {
      const divider = dividerRef.current;
      element.scrollTop = divider
        ? Math.max(0, divider.offsetTop - DIVIDER_OFFSET_PX)
        : element.scrollHeight;
      setNewCount(0);
    } else if (appended && (atBottomRef.current || stickRef.current)) {
      element.scrollTop = element.scrollHeight;
    } else {
      const anchor = anchorRef.current;
      const row = anchor ? rows(element).find((r) => r.dataset.anchorId === anchor.id) : undefined;
      if (anchor && row) element.scrollTop = row.offsetTop - anchor.offset;

      if (appended) {
        const previous = messages.findIndex((m) => m.id === lastIdRef.current);
        const added = previous === -1 ? 1 : messages.length - 1 - previous;
        setNewCount((count) => count + added);
      }
    }

    if (appended) stickRef.current = false;
    lastIdRef.current = lastId;
    conversationRef.current = conversationId;

    const atBottom = distanceFromBottom(element) <= NEAR_BOTTOM_PX;
    atBottomRef.current = atBottom;
    setShowJumpButton(!atBottom);
    anchorRef.current = readAnchor(element);
  }, [scrollRef, dividerRef, messages, conversationId]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    syncPosition(element);
    const { canLoadOlder: can, onLoadOlder: load } = loadRef.current;
    if (can && element.scrollTop <= NEAR_TOP_PX) load();
  }, [scrollRef, syncPosition]);

  const jumpToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const element = scrollRef.current;
      if (!element) return;
      // jsdom não implementa `scrollTo` em elemento; o navegador sempre tem.
      if (typeof element.scrollTo === 'function') {
        element.scrollTo({ top: element.scrollHeight, behavior });
      } else {
        element.scrollTop = element.scrollHeight;
      }
      // Já conta como "no fim": mensagem que chegar durante a rolagem suave desce junto.
      atBottomRef.current = true;
      setNewCount(0);
      setShowJumpButton(false);
    },
    [scrollRef],
  );

  const stickOnNextMessage = useCallback(() => {
    stickRef.current = true;
  }, []);

  return { showJumpButton, newCount, onScroll, jumpToBottom, stickOnNextMessage };
}
