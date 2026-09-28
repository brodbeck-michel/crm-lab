import { useState } from 'react';
import { Button } from '@/components/ui';
import { useMessageAlertsStore } from '@/stores';

/**
 * Aviso discreto "Ativar notificações" no topo da fila (CRMLAB-72, D-241 item 5).
 *
 * A permissão NUNCA é pedida no carregamento da página: só com o clique aqui,
 * como o WhatsApp Web. O aviso só aparece com a API disponível, a permissão
 * ainda não decidida (`default`) e a notificação ligada na preferência. Qualquer
 * resposta (concedida, negada ou fechada) esconde o aviso.
 */
function currentPermission(): NotificationPermission | null {
  return typeof Notification === 'undefined' ? null : Notification.permission;
}

export function EnableNotificationsBanner() {
  const notificationsEnabled = useMessageAlertsStore((s) => s.notificationsEnabled);
  const [permission, setPermission] = useState(currentPermission);
  const [asking, setAsking] = useState(false);

  if (!notificationsEnabled || permission !== 'default') return null;

  async function handleEnable(): Promise<void> {
    setAsking(true);
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      setPermission(currentPermission());
    } finally {
      setAsking(false);
    }
  }

  return (
    <div
      role="status"
      className="flex items-center gap-sm border-b border-neutral-300 bg-accent-100 px-md py-sm"
    >
      <p className="m-0 min-w-0 flex-1 font-body text-caption text-neutral-700">
        Receba um aviso quando chegar mensagem com a aba em segundo plano.
      </p>
      <Button variant="secondary" size="sm" loading={asking} onClick={() => void handleEnable()}>
        Ativar notificações
      </Button>
    </div>
  );
}
