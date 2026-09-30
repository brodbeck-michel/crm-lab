import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from './auth.store';
import {
  DRAFTS_STORAGE_KEY,
  DRAFT_TTL_MS,
  clearConversationDraft,
  pruneDrafts,
  readConversationDraft,
  saveConversationDraft,
  useDraftsStore,
} from './drafts.store';

/** Rascunho por conversa — D-243. */

const MARIA = { id: 'user-1', email: 'maria@lab.test', name: 'Maria', role: 'attendant', discountLimit: 5 } as const;
const JOANA = { ...MARIA, id: 'user-2', email: 'joana@lab.test', name: 'Joana' } as const;

beforeEach(() => {
  localStorage.clear();
  useDraftsStore.setState({ drafts: {} });
  useAuthStore.setState({ user: MARIA });
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null });
});

describe('drafts.store', () => {
  it('grava, lê e remove por conversa', () => {
    saveConversationDraft('conv-a', 'olá, tudo bem?');
    saveConversationDraft('conv-b', 'outra');
    expect(readConversationDraft('conv-a')).toBe('olá, tudo bem?');
    expect(readConversationDraft('conv-b')).toBe('outra');
    clearConversationDraft('conv-a');
    expect(readConversationDraft('conv-a')).toBeNull();
    expect(readConversationDraft('conv-b')).toBe('outra');
  });

  it('texto vazio ou só espaço remove o rascunho', () => {
    saveConversationDraft('conv-a', 'oi');
    saveConversationDraft('conv-a', '   ');
    expect(readConversationDraft('conv-a')).toBeNull();
    expect(useDraftsStore.getState().drafts).toEqual({});
  });

  it('guarda o texto como está (espaço no fim fica)', () => {
    saveConversationDraft('conv-a', 'bom dia ');
    expect(readConversationDraft('conv-a')).toBe('bom dia ');
  });

  it('cada usuário vê só o próprio rascunho', () => {
    saveConversationDraft('conv-a', 'da Maria');
    useAuthStore.setState({ user: JOANA });
    expect(readConversationDraft('conv-a')).toBeNull();
    saveConversationDraft('conv-a', 'da Joana');
    useAuthStore.setState({ user: MARIA });
    expect(readConversationDraft('conv-a')).toBe('da Maria');
  });

  it('sem sessão não grava nem lê', () => {
    useAuthStore.setState({ user: null });
    saveConversationDraft('conv-a', 'x');
    expect(readConversationDraft('conv-a')).toBeNull();
    expect(useDraftsStore.getState().drafts).toEqual({});
  });

  it('persiste em localStorage (sobrevive ao recarregar)', async () => {
    saveConversationDraft('conv-a', 'volto já');
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    // Simula a página nova: memória vazia, storage com o que ficou gravado.
    useDraftsStore.setState({ drafts: {} });
    localStorage.setItem(DRAFTS_STORAGE_KEY, raw as string);
    await useDraftsStore.persist.rehydrate();
    expect(readConversationDraft('conv-a')).toBe('volto já');
  });

  it('ao recarregar descarta o que passou do prazo e o que tem formato inválido', async () => {
    const now = Date.now();
    localStorage.setItem(
      DRAFTS_STORAGE_KEY,
      JSON.stringify({
        state: {
          drafts: {
            'user-1:novo': { text: 'fica', updatedAt: now - 1000 },
            'user-1:velho': { text: 'sai', updatedAt: now - DRAFT_TTL_MS - 1 },
            'user-1:torto': { text: 42, updatedAt: now },
            'user-1:vazio': { text: '  ', updatedAt: now },
          },
        },
        version: 0,
      }),
    );
    await useDraftsStore.persist.rehydrate();
    expect(Object.keys(useDraftsStore.getState().drafts)).toEqual(['user-1:novo']);
  });

  it('pruneDrafts aguenta lixo no storage', () => {
    expect(pruneDrafts(null, 0)).toEqual({});
    expect(pruneDrafts('x', 0)).toEqual({});
    expect(pruneDrafts({ a: null, b: [] }, 0)).toEqual({});
  });

  it('sair do sistema apaga todos os rascunhos', () => {
    saveConversationDraft('conv-a', 'x');
    useAuthStore.getState().clearSession();
    expect(useDraftsStore.getState().drafts).toEqual({});
  });

  it('localStorage quebrado (cota/modo privado) não derruba a gravação', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('cheio', 'QuotaExceededError');
    });
    expect(() => saveConversationDraft('conv-a', 'ainda em memória')).not.toThrow();
    expect(readConversationDraft('conv-a')).toBe('ainda em memória');
  });
});
