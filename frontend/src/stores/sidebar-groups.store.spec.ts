import { beforeEach, describe, expect, it } from 'vitest';
import { useSidebarGroupsStore } from './sidebar-groups.store';

beforeEach(() => {
  localStorage.clear();
  useSidebarGroupsStore.setState({ openByUser: {} });
});

describe('useSidebarGroupsStore — accordion da Sidebar (CRMLAB-4)', () => {
  it('grupo sem preferência salva começa aberto', () => {
    expect(useSidebarGroupsStore.getState().isGroupOpen('u-1', 'lis')).toBe(true);
  });

  it('toggleGroup fecha e reabre o grupo', () => {
    const { toggleGroup, isGroupOpen } = useSidebarGroupsStore.getState();

    toggleGroup('u-1', 'lis');
    expect(isGroupOpen('u-1', 'lis')).toBe(false);

    toggleGroup('u-1', 'lis');
    expect(isGroupOpen('u-1', 'lis')).toBe(true);
  });

  it('a preferência é isolada por usuário', () => {
    useSidebarGroupsStore.getState().toggleGroup('u-1', 'lis');

    expect(useSidebarGroupsStore.getState().isGroupOpen('u-1', 'lis')).toBe(false);
    expect(useSidebarGroupsStore.getState().isGroupOpen('u-2', 'lis')).toBe(true);
  });

  it('persiste em localStorage sob a chave crm-lab.sidebar-groups', () => {
    useSidebarGroupsStore.getState().toggleGroup('u-1', 'lis');

    const raw = localStorage.getItem('crm-lab.sidebar-groups');
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw as string) as { state: { openByUser: Record<string, unknown> } };
    expect(persisted.state.openByUser['u-1']).toEqual({ lis: false });
  });
});
