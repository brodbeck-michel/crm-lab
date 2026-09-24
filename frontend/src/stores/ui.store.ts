import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Estado de UI — docs/frontend/PAGES.md ("Estado Global").
 * NADA aqui vem do servidor: são preferências de exibição da sessão atual.
 */

/** Modais globais. `null` = nenhum aberto. */
export type ActiveModal = { kind: 'proposal'; id: string } | { kind: 'exam'; id: string | null } | null;

/**
 * Filtro compartilhado entre `/results`, `/reconciliation` e `/active-search`
 * (D-117, PAGES.md "Telas do LIS"). `attendantId`/`insuranceId` vazios ("")
 * significam "todos" — as telas convertem para `undefined` antes de montar a
 * query.
 */
export interface LisFilters {
  startDate: string;
  endDate: string;
  attendantId: string;
  insuranceId: string;
}

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

/** Default: últimos 30 dias terminando hoje — mesmo default do servidor. */
export function defaultLisFilters(): LisFilters {
  return {
    startDate: isoDaysAgo(29),
    endDate: new Date().toISOString().slice(0, 10),
    attendantId: '',
    insuranceId: '',
  };
}

/**
 * Preferência de recolher/expandir o trilho (CRMLAB-44, checklist "persiste
 * após reload"). Fica FORA do `persist` do resto do store (que é
 * sessionStorage, D-117) porque é uma preferência duradoura, não de sessão —
 * por isso um par ler/gravar dedicado em localStorage, só para esta chave.
 */
const SIDEBAR_COLLAPSED_KEY = 'crm-lab.sidebar-collapsed';

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(value: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(value));
  } catch {
    // localStorage indisponível (ex.: modo privado) — a preferência só não persiste.
  }
}

export interface UIState {
  /** Sidebar 264px (false) ou 76px (true). Persiste em localStorage à parte. */
  sidebarCollapsed: boolean;
  /** Terceira coluna do inbox (316px) visível. */
  contextPanelOpen: boolean;
  activeModal: ActiveModal;
  lisFilters: LisFilters;

  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setContextPanelOpen: (open: boolean) => void;
  toggleContextPanel: () => void;
  openModal: (modal: NonNullable<ActiveModal>) => void;
  closeModal: () => void;
  setLisFilters: (filters: LisFilters) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarCollapsed: readSidebarCollapsed(),
      contextPanelOpen: true,
      activeModal: null,
      lisFilters: defaultLisFilters(),

      setSidebarCollapsed: (sidebarCollapsed) => {
        writeSidebarCollapsed(sidebarCollapsed);
        set({ sidebarCollapsed });
      },
      toggleSidebar: () =>
        set((state) => {
          const sidebarCollapsed = !state.sidebarCollapsed;
          writeSidebarCollapsed(sidebarCollapsed);
          return { sidebarCollapsed };
        }),
      setContextPanelOpen: (contextPanelOpen) => set({ contextPanelOpen }),
      toggleContextPanel: () => set((state) => ({ contextPanelOpen: !state.contextPanelOpen })),
      openModal: (activeModal) => set({ activeModal }),
      closeModal: () => set({ activeModal: null }),
      setLisFilters: (lisFilters) => set({ lisFilters }),
    }),
    {
      name: 'crm-lab.ui.lis-filters',
      storage: createJSONStorage(() => sessionStorage),
      // D-117: só `lisFilters` persiste — sessão, não preferência duradoura
      // (sessionStorage, não localStorage: não deve vazar para o próximo
      // usuário do mesmo computador).
      partialize: (state) => ({ lisFilters: state.lisFilters }),
    },
  ),
);
