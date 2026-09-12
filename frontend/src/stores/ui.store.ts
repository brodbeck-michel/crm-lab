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

export interface UIState {
  /** Sidebar 244px (false) ou 72px (true). */
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
      sidebarCollapsed: false,
      contextPanelOpen: true,
      activeModal: null,
      lisFilters: defaultLisFilters(),

      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
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
