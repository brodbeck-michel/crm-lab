import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, cn } from '@/components/ui';
import { ALL_EMOJIS, EMOJI_CATEGORIES, searchEmojis } from './emoji-data';
import type { Emoji, EmojiCategoryId } from './emoji-data';

/**
 * Seletor de emoji do Composer — COMPONENTS.md (`conversation/`), Onda 8 §2.2,
 * refeito no CRMLAB-73 (D-243): busca em pt-BR, categorias e recentes.
 *
 * Lista estática versionada (`emoji-data.ts`), sem dependência: `emoji-mart`
 * pesa centenas de KB e fala inglês. Quem insere no cursor é o Composer
 * (`onPick`); abrir a busca não perde o cursor, porque o textarea guarda a
 * última seleção mesmo sem foco.
 *
 * Cada emoji é um `<button>` com `aria-label` em pt-BR: leitor de tela sem o
 * rótulo anuncia o codepoint, que não ajuda ninguém. `Esc` fecha e devolve o
 * foco a quem abriu (o `Composer` passa `onClose`).
 */

/** Todos os emojis do seletor (compatível com a exportação antiga). */
export const EMOJIS: readonly Emoji[] = ALL_EMOJIS;

export const RECENT_EMOJIS_KEY = 'crm-lab.emoji-recent';
export const MAX_RECENT_EMOJIS = 24;

const BY_CHAR = new Map(ALL_EMOJIS.map((emoji) => [emoji.char, emoji]));

/** Recentes do navegador; storage indisponível ou lixo → lista vazia. */
export function readRecentEmojis(): Emoji[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_EMOJIS_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((char) => (typeof char === 'string' ? BY_CHAR.get(char) : undefined))
      .filter((emoji): emoji is Emoji => emoji !== undefined);
  } catch {
    return [];
  }
}

function rememberEmoji(char: string): void {
  try {
    const current = readRecentEmojis().map((emoji) => emoji.char);
    const next = [char, ...current.filter((item) => item !== char)].slice(0, MAX_RECENT_EMOJIS);
    localStorage.setItem(RECENT_EMOJIS_KEY, JSON.stringify(next));
  } catch {
    // Sem storage: os recentes só não persistem.
  }
}

export interface EmojiPickerProps {
  /** Recebe o caractere escolhido. O popover fecha sozinho depois. */
  onPick: (emoji: string) => void;
  /** Chamado ao fechar por `Esc`, clique fora ou escolha — devolve o foco. */
  onClose?: () => void;
  disabled?: boolean;
}

type TabId = 'recent' | EmojiCategoryId;

/** Carinha em SVG inline — mesmo padrão do clipe de papel do Composer. */
function EmojiIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="flex-[0_0_15px]"
    >
      <circle cx="8" cy="8" r="6.4" />
      <path d="M5.6 9.4a3 3 0 0 0 4.8 0" />
      <path d="M6 6.2h.01M10 6.2h.01" />
    </svg>
  );
}

export function EmojiPicker({ onPick, onClose, disabled = false }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<Emoji[]>([]);
  const [tab, setTab] = useState<TabId>('smileys');
  const ref = useRef<HTMLDivElement>(null);

  function toggle(): void {
    if (open) {
      setOpen(false);
      return;
    }
    const saved = readRecentEmojis();
    setRecent(saved);
    setTab(saved.length > 0 ? 'recent' : 'smileys');
    setQuery('');
    setOpen(true);
  }

  function close(): void {
    setOpen(false);
    onClose?.();
  }

  function pick(emoji: Emoji): void {
    rememberEmoji(emoji.char);
    onPick(emoji.char);
    close();
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      onClose?.();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  const searching = query.trim().length > 0;
  const results = useMemo(() => (searching ? searchEmojis(query) : []), [searching, query]);
  const category = EMOJI_CATEGORIES.find((item) => item.id === tab);
  const visible = searching ? results : tab === 'recent' ? recent : (category?.emojis ?? []);
  const gridLabel = searching
    ? 'Resultados da busca'
    : tab === 'recent'
      ? 'Recentes'
      : (category?.label ?? '');

  const tabClass = (active: boolean) =>
    cn(
      'flex-1 cursor-pointer rounded-sm border-none bg-transparent px-0 py-xs font-body text-label leading-none',
      'hover:bg-accent-100',
      active && 'bg-accent-100 shadow-sm',
    );

  return (
    <div ref={ref} className="relative flex-[0_0_auto]">
      <Button
        variant="secondary"
        size="sm"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Inserir emoji"
      >
        <EmojiIcon />
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Emojis"
          className={cn(
            'absolute bottom-full left-0 z-50 mb-xs flex w-[320px] flex-col gap-sm rounded-md border',
            'border-neutral-200 bg-surface p-sm shadow-md',
          )}
        >
          <input
            type="search"
            value={query}
            // O cursor do textarea não se perde: ele guarda a última seleção.
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && results[0]) {
                event.preventDefault();
                pick(results[0]);
              }
            }}
            placeholder="Buscar emoji"
            aria-label="Buscar emoji"
            className={cn(
              'w-full rounded-pill border border-neutral-300 bg-bg px-md py-xs font-body text-label text-text',
              'outline-none placeholder:text-neutral-600 focus:border-accent',
            )}
          />

          {!searching && (
            <div role="tablist" aria-label="Categorias de emoji" className="flex gap-xs">
              {recent.length > 0 && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'recent'}
                  aria-label="Recentes"
                  title="Recentes"
                  onClick={() => setTab('recent')}
                  className={tabClass(tab === 'recent')}
                >
                  🕘
                </button>
              )}
              {EMOJI_CATEGORIES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  aria-label={item.label}
                  title={item.label}
                  onClick={() => setTab(item.id)}
                  className={tabClass(tab === item.id)}
                >
                  {item.icon}
                </button>
              ))}
            </div>
          )}

          <p className="m-0 font-body text-caption text-neutral-600">{gridLabel}</p>

          {visible.length === 0 ? (
            <p className="m-0 py-md text-center font-body text-caption text-neutral-600">
              Nenhum emoji encontrado
            </p>
          ) : (
            <div
              role="group"
              aria-label={gridLabel}
              className="grid max-h-[216px] grid-cols-8 gap-xs overflow-y-auto"
            >
              {visible.map((emoji, index) => (
                <button
                  // O mesmo caractere pode repetir com rótulos diferentes.
                  key={`${emoji.char}-${index}`}
                  type="button"
                  aria-label={emoji.label}
                  title={emoji.label}
                  onClick={() => pick(emoji)}
                  className="cursor-pointer rounded-sm border-none bg-transparent p-xs text-label leading-none hover:bg-accent-100"
                >
                  {emoji.char}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
