import { useEffect, useState, useSyncExternalStore } from 'react';
import { onRateLimit, rateLimitedUntilMs } from '@/api';
import { getTabPresence, type TabPresence } from '@/lib/tab-presence';

/**
 * Aviso discreto de excesso de tráfego (CRMLAB-122, D-288). Duas situações:
 *  - a aba bateu no limite (429) e está esperando a janela virar — a tela
 *    NÃO trava nem desloga: o client HTTP espera e repete sozinho;
 *  - o CRM está aberto em mais de uma aba (todas somam no mesmo limite).
 *
 * Pílula fixa no rodapé central (o toast fica no canto direito): não empurra o
 * layout — o Atendimento tem altura exata de viewport (InboxLayout).
 */

/** `true` enquanto o client está segurando requisições por 429. */
export function useRateLimited(): boolean {
  const [until, setUntil] = useState(() => rateLimitedUntilMs());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => onRateLimit(setUntil), []);

  useEffect(() => {
    const remaining = until - Date.now();
    if (remaining <= 0) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), remaining + 50);
    return () => clearTimeout(timer);
  }, [until]);

  return until > now;
}

/** Quantas OUTRAS abas do CRM estão abertas neste navegador. */
export function useOtherTabsCount(presence: TabPresence = getTabPresence()): number {
  return useSyncExternalStore(presence.subscribe, presence.otherTabs, () => 0);
}

export function TrafficNotice({ presence }: { presence?: TabPresence }) {
  const rateLimited = useRateLimited();
  const otherTabs = useOtherTabsCount(presence);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  // "Entendi" esconde o aviso de abas até o número de abas SUBIR de novo.
  const tabsNoticeVisible = otherTabs > 0 && (dismissedAt === null || otherTabs > dismissedAt);
  if (!rateLimited && !tabsNoticeVisible) return null;

  const tabs = otherTabs + 1;
  const message = rateLimited
    ? otherTabs > 0
      ? `Muitas requisições ao mesmo tempo (o CRM está aberto em ${tabs} abas). Aguarde alguns segundos — a tela volta sozinha. Feche as abas que não estiver usando.`
      : 'Muitas requisições ao mesmo tempo. Aguarde alguns segundos — a tela volta sozinha.'
    : `O CRM está aberto em ${tabs} abas. Todas somam no mesmo limite de acesso — feche as que não estiver usando.`;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="traffic-notice"
      className="pointer-events-none fixed bottom-xl left-1/2 z-40 flex w-full max-w-[560px] -translate-x-1/2 justify-center px-md"
    >
      <div className="pointer-events-auto flex items-center gap-md rounded-lg border border-neutral-300 bg-accent-100 px-lg py-sm font-body text-caption text-neutral-700 shadow-md">
        <span className="min-w-0 flex-1">{message}</span>
        {!rateLimited && (
          <button
            type="button"
            onClick={() => setDismissedAt(otherTabs)}
            className="flex-[0_0_auto] cursor-pointer rounded-pill border-none bg-transparent px-xs font-body text-caption font-bold text-current"
          >
            Entendi
          </button>
        )}
      </div>
    </div>
  );
}
