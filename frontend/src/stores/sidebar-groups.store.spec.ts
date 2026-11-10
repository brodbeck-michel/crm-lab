import { beforeEach, describe, expect, it } from 'vitest';
import { useSidebarGroupsStore } from './sidebar-groups.store';

beforeEach(() => {
  localStorage.clear();
  useSidebarGroupsStore.setState({ openByUser: {} });
});

describe('useSidebarGroupsStore — accordion da Sidebar (CRMLAB-4, default fechado no CRMLAB-143)', () => {
  it('grupo sem preferência salva começa fechado', () => {
    expect(useSidebarGroupsStore.getState().isGroupOpen('u-1', 'lis')).toBe(false);
  });

  it('toggleGroup abre e fecha o grupo', () => {
    const { toggleGroup, isGroupOpen } = useSidebarGroupsStore.getState();

    toggleGroup('u-1', 'lis');
    expect(isGroupOpen('u-1', 'lis')).toBe(true);

    toggleGroup('u-1', 'lis');
    expect(isGroupOpen('u-1', 'lis')).toBe(false);
  });

  it('`currentlyOpen` manda quando a Sidebar abriu o grupo sozinha (tela atual)', () => {
    const { toggleGroup, isGroupOpen } = useSidebarGroupsStore.getState();

    // Sem preferência salva, mas o usuário está VENDO o grupo aberto: o clique fecha.
    toggleGroup('u-1', 'lis', true);
    expect(isGroupOpen('u-1', 'lis')).toBe(false);
    expect(useSidebarGroupsStore.getState().openByUser['u-1']).toEqual({ lis: false });
  });

  it('a preferência é isolada por usuário', () => {
    useSidebarGroupsStore.getState().toggleGroup('u-1', 'lis');

    expect(useSidebarGroupsStore.getState().isGroupOpen('u-1', 'lis')).toBe(true);
    expect(useSidebarGroupsStore.getState().isGroupOpen('u-2', 'lis')).toBe(false);
  });

  it('persiste em localStorage sob a chave crm-lab.sidebar-groups', () => {
    useSidebarGroupsStore.getState().toggleGroup('u-1', 'lis');

    const raw = localStorage.getItem('crm-lab.sidebar-groups');
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw as string) as { state: { openByUser: Record<string, unknown> } };
    expect(persisted.state.openByUser['u-1']).toEqual({ lis: true });
  });
});
