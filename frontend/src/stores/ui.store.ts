import { create } from 'zustand';

/**
 * Estado de UI — docs/frontend/PAGES.md ("Estado Global").
 * NADA aqui vem do servidor: são preferências de exibição da sessão atual.
 */

/** Modais globais. `null` = nenhum aberto. */
export type ActiveModal = { kind: 'proposal'; id: string } | { kind: 'exam'; id: string | null } | null;

export interface UIState {
  /** Sidebar 244px (false) ou 72px (true). */
  sidebarCollapsed: boolean;
  /** Terceira coluna do inbox (316px) visível. */
  contextPanelOpen: boolean;
  activeModal: ActiveModal;

  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setContextPanelOpen: (open: boolean) => void;
  toggleContextPanel: () => void;
  openModal: (modal: NonNullable<ActiveModal>) => void;
  closeModal: () => void;
}

export const useUIStore = create<UIState>()((set) => ({
  sidebarCollapsed: false,
  contextPanelOpen: true,
  activeModal: null,

  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setContextPanelOpen: (contextPanelOpen) => set({ contextPanelOpen }),
  toggleContextPanel: () => set((state) => ({ contextPanelOpen: !state.contextPanelOpen })),
  openModal: (activeModal) => set({ activeModal }),
  closeModal: () => set({ activeModal: null }),
}));
