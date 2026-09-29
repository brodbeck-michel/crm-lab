import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMOJI_CATEGORIES, ALL_EMOJIS, searchEmojis } from './emoji-data';
import { EmojiPicker, MAX_RECENT_EMOJIS, RECENT_EMOJIS_KEY } from './EmojiPicker';

/** EmojiPicker — busca pt-BR, categorias e recentes sobre lista estática (D-243). */

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

async function openPicker(onPick = vi.fn(), onClose = vi.fn()) {
  const user = userEvent.setup();
  render(<EmojiPicker onPick={onPick} onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: 'Inserir emoji' }));
  return { user, onPick, onClose };
}

describe('emoji-data', () => {
  it('lista grande, 8 categorias, sem emoji repetido na mesma categoria e todo mundo com nome', () => {
    expect(EMOJI_CATEGORIES.map((category) => category.id)).toEqual([
      'smileys',
      'animals',
      'food',
      'activities',
      'travel',
      'objects',
      'symbols',
      'flags',
    ]);
    expect(ALL_EMOJIS.length).toBeGreaterThan(350);
    for (const category of EMOJI_CATEGORIES) {
      const chars = category.emojis.map((emoji) => emoji.char);
      expect(new Set(chars).size).toBe(chars.length);
    }
    expect(ALL_EMOJIS.every((emoji) => emoji.label.trim().length > 0)).toBe(true);
  });

  it('busca sem acento e sem caixa, por nome e palavra-chave, todas as palavras', () => {
    expect(searchEmojis('coracao').map((emoji) => emoji.char)).toContain('❤️');
    expect(searchEmojis('CORAÇÃO verde').map((emoji) => emoji.char)).toEqual(['💚']);
    expect(searchEmojis('laboratorio').map((emoji) => emoji.char)).toEqual(
      expect.arrayContaining(['🧪', '🔬']),
    );
    expect(searchEmojis('   ')).toEqual([]);
    expect(searchEmojis('xyzxyz')).toEqual([]);
  });
});

describe('EmojiPicker', () => {
  it('abre com a busca focada e as abas de categoria (sem Recentes quando não há)', async () => {
    await openPicker();
    expect(screen.getByRole('searchbox', { name: 'Buscar emoji' })).toHaveFocus();
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(
      EMOJI_CATEGORIES.map((category) => category.label),
    );
    expect(screen.getByRole('tab', { name: 'Smileys e pessoas' })).toHaveAttribute('aria-selected', 'true');
  });

  it('trocar de aba mostra a categoria', async () => {
    const { user } = await openPicker();
    await user.click(screen.getByRole('tab', { name: 'Objetos' }));
    const grid = screen.getByRole('group', { name: 'Objetos' });
    expect(within(grid).getByRole('button', { name: 'exame' })).toBeInTheDocument();
  });

  it('busca em português e escolhe; Enter pega o primeiro resultado', async () => {
    const { user, onPick } = await openPicker();
    await user.type(screen.getByRole('searchbox'), 'seringa');
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith('💉');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('busca sem resultado avisa', async () => {
    const { user } = await openPicker();
    await user.type(screen.getByRole('searchbox'), 'xyzxyz');
    expect(screen.getByText('Nenhum emoji encontrado')).toBeInTheDocument();
  });

  it('o escolhido vai para Recentes (primeiro da lista, sem repetir, até o limite)', async () => {
    const { user, onPick } = await openPicker();
    await user.click(screen.getByRole('button', { name: 'joinha' }));
    expect(onPick).toHaveBeenCalledWith('👍');

    await user.click(screen.getByRole('button', { name: 'Inserir emoji' }));
    expect(screen.getByRole('tab', { name: 'Recentes' })).toHaveAttribute('aria-selected', 'true');
    const grid = screen.getByRole('group', { name: 'Recentes' });
    expect(within(grid).getAllByRole('button').map((button) => button.textContent)).toEqual(['👍']);

    const many = ALL_EMOJIS.slice(0, 40).map((emoji) => emoji.char);
    localStorage.setItem(RECENT_EMOJIS_KEY, JSON.stringify(many));
    await user.click(within(grid).getByRole('button', { name: 'joinha' }));
    const saved = JSON.parse(localStorage.getItem(RECENT_EMOJIS_KEY) ?? '[]') as string[];
    expect(saved[0]).toBe('👍');
    expect(saved).toHaveLength(MAX_RECENT_EMOJIS);
    expect(saved.filter((char) => char === '👍')).toHaveLength(1);
  });

  it('recentes com lixo ou storage quebrado não derrubam o seletor', async () => {
    localStorage.setItem(RECENT_EMOJIS_KEY, '{nao é json');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('cheio', 'QuotaExceededError');
    });
    const { user, onPick } = await openPicker();
    expect(screen.queryByRole('tab', { name: 'Recentes' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'joinha' }));
    expect(onPick).toHaveBeenCalledWith('👍');
  });

  it('Esc fecha e avisa onClose (o Composer devolve o foco)', async () => {
    const { user, onClose } = await openPicker();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalled();
  });
});
