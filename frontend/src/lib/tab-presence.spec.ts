import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTabPresence, type BroadcastChannelLike, type TabPresence } from './tab-presence';

/**
 * CRMLAB-122 (D-288): contagem de abas e eleição da aba que mantém o aviso de
 * mensagem nova vivo em segundo plano. Um "barramento" falso liga os canais.
 */

class Bus {
  channels = new Set<FakeChannel>();
}

class FakeChannel implements BroadcastChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(private readonly bus: Bus) {
    bus.channels.add(this);
  }
  postMessage(message: unknown): void {
    for (const other of this.bus.channels) {
      if (other !== this) other.onmessage?.({ data: message });
    }
  }
  close(): void {
    this.bus.channels.delete(this);
  }
}

let bus: Bus;
const tabs: TabPresence[] = [];

function openTab(id: string, startedAt: number, visible: () => boolean = () => true): TabPresence {
  const tab = createTabPresence({ channel: new FakeChannel(bus), id, startedAt, isVisible: visible });
  tab.start();
  tabs.push(tab);
  return tab;
}

beforeEach(() => {
  vi.useFakeTimers();
  bus = new Bus();
});

afterEach(() => {
  tabs.splice(0).forEach((t) => t.stop());
  vi.useRealTimers();
});

describe('tab-presence', () => {
  it('cada aba enxerga as outras assim que abre (hello → beat)', () => {
    const a = openTab('a', 1);
    const b = openTab('b', 2);
    const c = openTab('c', 3);
    expect(a.otherTabs()).toBe(2);
    expect(b.otherTabs()).toBe(2);
    expect(c.otherTabs()).toBe(2);
  });

  it('fechar a aba (bye) tira da conta na hora', () => {
    const a = openTab('a', 1);
    const b = openTab('b', 2);
    expect(a.otherTabs()).toBe(1);
    b.stop();
    expect(a.otherTabs()).toBe(0);
  });

  it('aba que some sem bye sai da conta depois de 15 s sem batimento', () => {
    const a = openTab('a', 1);
    // Aba "travada": anuncia uma vez e nunca mais.
    a.receive({ type: 'hello', id: 'zumbi', startedAt: 0, visible: false });
    expect(a.otherTabs()).toBe(1);
    vi.advanceTimersByTime(16_000);
    expect(a.otherTabs()).toBe(0);
  });

  it('avisa quem assina quando a contagem muda', () => {
    const a = openTab('a', 1);
    const listener = vi.fn();
    a.subscribe(listener);
    openTab('b', 2);
    expect(listener).toHaveBeenCalled();
  });

  it('sem canal (browser antigo) é aba única: não conta ninguém e mantém o aviso vivo', () => {
    const solo = createTabPresence({ channel: null });
    solo.start();
    expect(solo.otherTabs()).toBe(0);
    expect(solo.keepsBackgroundAlive()).toBe(true);
    solo.stop();
  });

  it('todas escondidas: só a mais antiga mantém o aviso vivo', () => {
    const a = openTab('a', 1, () => false);
    const b = openTab('b', 2, () => false);
    expect(a.keepsBackgroundAlive()).toBe(true);
    expect(b.keepsBackgroundAlive()).toBe(false);
  });

  it('alguma aba visível: nenhuma escondida precisa refazer nada', () => {
    let bVisible = false;
    const a = openTab('a', 1, () => false);
    openTab('b', 2, () => bVisible);
    expect(a.keepsBackgroundAlive()).toBe(true);
    bVisible = true;
    tabs[1]?.tick(); // b anuncia a nova visibilidade
    expect(a.keepsBackgroundAlive()).toBe(false);
  });
});
