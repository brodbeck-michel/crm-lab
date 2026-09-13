import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Estado aberto/fechado dos grupos (accordion) do trilho — CRMLAB-4.
 * Preferência duradoura por usuário, por isso localStorage (ao contrário do
 * recolher/expandir do trilho inteiro, em ui.store, que não persiste).
 * Default (sem preferência salva): grupo aberto.
 */
export interface SidebarGroupsState {
  /** userId -> groupId -> aberto. */
  openByUser: Record<string, Record<string, boolean>>;
  isGroupOpen: (userId: string, groupId: string) => boolean;
  toggleGroup: (userId: string, groupId: string) => void;
}

export const useSidebarGroupsStore = create<SidebarGroupsState>()(
  persist(
    (set, get) => ({
      openByUser: {},
      isGroupOpen: (userId, groupId) => get().openByUser[userId]?.[groupId] ?? true,
      toggleGroup: (userId, groupId) =>
        set((state) => {
          const current = state.openByUser[userId] ?? {};
          const isOpen = current[groupId] ?? true;
          return { openByUser: { ...state.openByUser, [userId]: { ...current, [groupId]: !isOpen } } };
        }),
    }),
    {
      name: 'crm-lab.sidebar-groups',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
