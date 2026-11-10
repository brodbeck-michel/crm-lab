import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Estado aberto/fechado dos grupos (accordion) do trilho — CRMLAB-4.
 * Preferência duradoura por usuário, por isso localStorage (ao contrário do
 * recolher/expandir do trilho inteiro, em ui.store, que não persiste).
 * Sem preferência salva o grupo fica FECHADO (CRMLAB-143) — quem decide o
 * estado efetivo é a Sidebar, que abre sozinha o grupo da tela atual e passa
 * esse estado para `toggleGroup`.
 */
export interface SidebarGroupsState {
  /** userId -> groupId -> aberto. */
  openByUser: Record<string, Record<string, boolean>>;
  isGroupOpen: (userId: string, groupId: string) => boolean;
  /** `currentlyOpen`: o estado que o usuário está VENDO (pode vir do default da Sidebar). */
  toggleGroup: (userId: string, groupId: string, currentlyOpen?: boolean) => void;
}

export const useSidebarGroupsStore = create<SidebarGroupsState>()(
  persist(
    (set, get) => ({
      openByUser: {},
      isGroupOpen: (userId, groupId) => get().openByUser[userId]?.[groupId] ?? false,
      toggleGroup: (userId, groupId, currentlyOpen) =>
        set((state) => {
          const current = state.openByUser[userId] ?? {};
          const isOpen = currentlyOpen ?? current[groupId] ?? false;
          return { openByUser: { ...state.openByUser, [userId]: { ...current, [groupId]: !isOpen } } };
        }),
    }),
    {
      name: 'crm-lab.sidebar-groups',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
