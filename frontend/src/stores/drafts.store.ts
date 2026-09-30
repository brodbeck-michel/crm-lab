import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import { useAuthStore } from './auth.store';

/**
 * Rascunho por conversa (CRMLAB-73, D-243) — só no navegador, nada no backend.
 *
 * - Chave `userId:conversationId`: no computador compartilhado da recepção uma
 *   atendente não vê o rascunho da outra.
 * - Texto vazio (enviou ou apagou tudo) remove o rascunho.
 * - Sem mexer há `DRAFT_TTL_MS` → descartado ao carregar a página.
 * - Sair do sistema apaga todos (é texto de atendimento de paciente).
 * - `localStorage` pode não existir ou estar cheio (modo privado, cota): o
 *   `StateStorage` abaixo engole o erro e o rascunho só não persiste.
 */

export interface ConversationDraft {
  text: string;
  /** `Date.now()` da última mudança — base da limpeza por idade. */
  updatedAt: number;
}

export interface DraftsState {
  /** `userId:conversationId` → rascunho. */
  drafts: Record<string, ConversationDraft>;
  setDraft: (userId: string, conversationId: string, text: string) => void;
  clearDraft: (userId: string, conversationId: string) => void;
  clearAll: () => void;
}

export const DRAFTS_STORAGE_KEY = 'crm-lab.drafts';
export const DRAFT_TTL_MS = 5 * 24 * 60 * 60 * 1000;

export const draftKey = (userId: string, conversationId: string): string =>
  `${userId}:${conversationId}`;

const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      // Cota cheia / sem storage: fica só em memória.
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      // idem
    }
  },
};

function isDraft(value: unknown): value is ConversationDraft {
  if (typeof value !== 'object' || value === null) return false;
  const { text, updatedAt } = value as Record<string, unknown>;
  return typeof text === 'string' && typeof updatedAt === 'number';
}

/** Só o que tem o formato certo e ainda está no prazo — o storage é entrada não confiável. */
export function pruneDrafts(raw: unknown, now: number): Record<string, ConversationDraft> {
  const kept: Record<string, ConversationDraft> = {};
  if (typeof raw !== 'object' || raw === null) return kept;
  for (const [key, value] of Object.entries(raw)) {
    if (isDraft(value) && value.text.trim() !== '' && now - value.updatedAt < DRAFT_TTL_MS) {
      kept[key] = value;
    }
  }
  return kept;
}

export const useDraftsStore = create<DraftsState>()(
  persist(
    (set) => ({
      drafts: {},
      setDraft: (userId, conversationId, text) =>
        set((state) => {
          const key = draftKey(userId, conversationId);
          if (text.trim() === '') {
            if (!(key in state.drafts)) return state;
            const { [key]: _removed, ...rest } = state.drafts;
            return { drafts: rest };
          }
          if (state.drafts[key]?.text === text) return state;
          return { drafts: { ...state.drafts, [key]: { text, updatedAt: Date.now() } } };
        }),
      clearDraft: (userId, conversationId) =>
        set((state) => {
          const key = draftKey(userId, conversationId);
          if (!(key in state.drafts)) return state;
          const { [key]: _removed, ...rest } = state.drafts;
          return { drafts: rest };
        }),
      clearAll: () => set({ drafts: {} }),
    }),
    {
      name: DRAFTS_STORAGE_KEY,
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state) => ({ drafts: state.drafts }),
      merge: (persisted, current) => ({
        ...current,
        drafts: pruneDrafts((persisted as { drafts?: unknown } | undefined)?.drafts, Date.now()),
      }),
    },
  ),
);

// Sair do sistema (ou a sessão cair) apaga os rascunhos deste navegador.
useAuthStore.subscribe((state, previous) => {
  if (previous.user && !state.user) useDraftsStore.getState().clearAll();
});

/** Rascunho da conversa para o usuário logado (`null` sem rascunho ou sem sessão). */
export function useConversationDraft(conversationId: string): string | null {
  const userId = useAuthStore((state) => state.user?.id ?? null);
  return useDraftsStore((state) =>
    userId ? (state.drafts[draftKey(userId, conversationId)]?.text ?? null) : null,
  );
}

/** Leitura fora de render (semente do Composer). */
export function readConversationDraft(conversationId: string): string | null {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) return null;
  return useDraftsStore.getState().drafts[draftKey(userId, conversationId)]?.text ?? null;
}

/** Grava (ou, vazio, remove) o rascunho do usuário logado. Sem sessão, nada. */
export function saveConversationDraft(conversationId: string, text: string): void {
  const userId = useAuthStore.getState().user?.id;
  if (userId) useDraftsStore.getState().setDraft(userId, conversationId, text);
}

export function clearConversationDraft(conversationId: string): void {
  const userId = useAuthStore.getState().user?.id;
  if (userId) useDraftsStore.getState().clearDraft(userId, conversationId);
}
