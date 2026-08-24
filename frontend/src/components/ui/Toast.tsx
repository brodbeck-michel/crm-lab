import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from './cn';

export type ToastTone = 'positive' | 'attention' | 'neutral';

export interface ToastOptions {
  /** `positive` = accent-2 (concluído), `attention` = accent (exige atenção). */
  tone?: ToastTone;
  /** ms até sumir sozinho. `0` mantém até o usuário fechar. Padrão 4000. */
  durationMs?: number;
}

export interface ToastItem extends Required<ToastOptions> {
  id: string;
  message: string;
}

export interface ToastApi {
  /** Enfileira um toast e devolve o id (para `dismiss` manual). */
  toast: (message: string, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONES: Record<ToastTone, string> = {
  positive: 'bg-accent2-200 text-accent2-800',
  attention: 'bg-accent-200 text-accent-800',
  neutral: 'bg-neutral-100 text-neutral-800',
};

/** Envolve a aplicação uma única vez, no topo da árvore. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seq = useRef(0);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, options: ToastOptions = {}) => {
      seq.current += 1;
      const id = `toast-${seq.current}`;
      const item: ToastItem = {
        id,
        message,
        tone: options.tone ?? 'neutral',
        durationMs: options.durationMs ?? 4000,
      };
      setItems((current) => [...current, item]);

      if (item.durationMs > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), item.durationMs),
        );
      }
      return id;
    },
    [dismiss],
  );

  // Limpa timers pendentes ao desmontar.
  const timersRef = timers;
  useEffect(() => {
    const map = timersRef.current;
    return () => {
      map.forEach((timer) => clearTimeout(timer));
      map.clear();
    };
  }, [timersRef]);

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="region"
        aria-label="Notificações"
        className="pointer-events-none fixed bottom-xl right-xl z-50 flex flex-col gap-sm"
      >
        {items.map((item) => (
          <div
            key={item.id}
            role="status"
            aria-live="polite"
            data-tone={item.tone}
            className={cn(
              'pointer-events-auto flex max-w-[360px] items-start gap-md rounded-lg px-lg py-md',
              'font-body text-label shadow-md',
              TONES[item.tone],
            )}
          >
            <span className="min-w-0 flex-1">{item.message}</span>
            <button
              type="button"
              aria-label="Fechar notificação"
              onClick={() => dismiss(item.id)}
              className="flex-[0_0_auto] cursor-pointer rounded-pill border-none bg-transparent px-xs font-body text-caption font-bold text-current"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Acesso ao toaster. Lança se usado fora do `ToastProvider`. */
export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast precisa estar dentro de <ToastProvider>');
  }
  return context;
}
