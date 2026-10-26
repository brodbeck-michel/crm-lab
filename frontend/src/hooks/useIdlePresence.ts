import { useEffect } from 'react';
import { USER_IDLE_AFTER_MS } from '@crm-lab/shared';
import { useUpdateMyPresence } from '@/api';
import { useAuthStore, selectRole } from '@/stores';

/** Chave do horário da última atividade, dividida entre as abas (D-286 item 4). */
export const LAST_ACTIVITY_STORAGE_KEY = 'crm-lab:last-activity';

/** De quanto em quanto tempo a aba confere se ficou parada. */
export const IDLE_CHECK_INTERVAL_MS = 30_000;

/** Intervalo mínimo entre gravações no `localStorage` (mousemove dispara muito). */
const WRITE_THROTTLE_MS = 15_000;

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

function readShared(): number {
  try {
    const raw = window.localStorage.getItem(LAST_ACTIVITY_STORAGE_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function writeShared(at: number): void {
  try {
    window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(at));
  } catch {
    // Storage bloqueado: cada aba conta só a própria atividade.
  }
}

/**
 * Ausente automático (CRMLAB-120, D-286 item 4): 30 min sem mexer em NENHUMA
 * aba → avisa `idle: true`; ao mexer de novo → `idle: false` e o status volta
 * ao escolhido. As abas dividem o horário da última atividade pelo
 * `localStorage`, então trabalhar numa aba mantém as outras ativas. Só manda
 * quando o estado muda — o backend também ignora repetição.
 */
export function useIdlePresence(): void {
  const role = useAuthStore(selectRole);
  const { mutate } = useUpdateMyPresence();
  const enabled = role !== null && role !== 'platform_operator';

  useEffect(() => {
    if (!enabled) return;

    let lastLocal = Date.now();
    let lastWritten = 0;
    let sentIdle = false;
    writeShared(lastLocal);

    const check = (): void => {
      const lastActivity = Math.max(lastLocal, readShared());
      const idle = Date.now() - lastActivity >= USER_IDLE_AFTER_MS;
      if (idle === sentIdle) return;
      sentIdle = idle;
      mutate({ idle });
    };

    const onActivity = (): void => {
      const now = Date.now();
      lastLocal = now;
      if (now - lastWritten >= WRITE_THROTTLE_MS) {
        lastWritten = now;
        writeShared(now);
      }
      // Voltou: avisa na hora, sem esperar o próximo ciclo.
      if (sentIdle) check();
    };

    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, onActivity, { passive: true });
    }
    const timer = window.setInterval(check, IDLE_CHECK_INTERVAL_MS);

    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity);
      window.clearInterval(timer);
    };
  }, [enabled, mutate]);
}
