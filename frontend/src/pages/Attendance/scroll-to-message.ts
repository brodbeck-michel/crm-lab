/**
 * "Rolar até a mensagem original" (CRMLAB-66, D-221) — isolado de propósito:
 * a rolagem da lista é do `useConversationScroll` (CRMLAB-71); isto só procura o
 * balão pelo `data-message-id`, traz para o meio da tela e acende o destaque
 * (`data-highlighted`) por um instante.
 *
 * `false` = a original não está no que foi carregado (quem chama avisa). Buscar
 * páginas antigas até achar fica para depois.
 */
export const HIGHLIGHT_MS = 1600;

export function scrollToMessage(container: HTMLElement | null, messageId: string): boolean {
  if (!container) return false;
  const target = container.querySelector<HTMLElement>(
    `[data-message-id="${messageId.replace(/"/g, '')}"]`,
  );
  if (!target) return false;
  // jsdom não implementa `scrollIntoView`; no navegador ele sempre existe.
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  target.dataset.highlighted = 'true';
  window.setTimeout(() => {
    delete target.dataset.highlighted;
  }, HIGHLIGHT_MS);
  return true;
}
