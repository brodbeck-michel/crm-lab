import { create } from 'zustand';

/**
 * Aviso de mensagem nova (CRMLAB-72, D-241) — estado de UI, nada do servidor.
 *
 * - Preferências de som e de notificação: por navegador, em `localStorage`
 *   (D-241 item 8), ligadas por padrão. Leitura e escrita com `try/catch`:
 *   armazenamento bloqueado (modo privado, política do navegador) só faz a
 *   preferência não persistir.
 * - `openConversationId`: a conversa aberta no Atendimento. É a tela que
 *   publica (e limpa ao sair); o hook `useNewMessageAlerts` lê para não avisar
 *   da conversa que a atendente já está olhando.
 */

export const ALERT_SOUND_KEY = 'crm-lab.alerts.sound';
export const ALERT_NOTIFICATIONS_KEY = 'crm-lab.alerts.notifications';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) !== 'false';
  } catch {
    return true;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // localStorage indisponível — a preferência só não persiste.
  }
}

export interface MessageAlertsState {
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  openConversationId: string | null;
  setSoundEnabled: (enabled: boolean) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setOpenConversationId: (id: string | null) => void;
}

export const useMessageAlertsStore = create<MessageAlertsState>()((set) => ({
  soundEnabled: readFlag(ALERT_SOUND_KEY),
  notificationsEnabled: readFlag(ALERT_NOTIFICATIONS_KEY),
  openConversationId: null,
  setSoundEnabled: (soundEnabled) => {
    writeFlag(ALERT_SOUND_KEY, soundEnabled);
    set({ soundEnabled });
  },
  setNotificationsEnabled: (notificationsEnabled) => {
    writeFlag(ALERT_NOTIFICATIONS_KEY, notificationsEnabled);
    set({ notificationsEnabled });
  },
  setOpenConversationId: (openConversationId) => set({ openConversationId }),
}));

/** Relê o `localStorage` — o que um reload faria (usado nos testes). */
export function reloadMessageAlertPrefs(): void {
  useMessageAlertsStore.setState({
    soundEnabled: readFlag(ALERT_SOUND_KEY),
    notificationsEnabled: readFlag(ALERT_NOTIFICATIONS_KEY),
  });
}
