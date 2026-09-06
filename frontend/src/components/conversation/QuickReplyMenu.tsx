import { useMemo } from 'react';
import { cn } from '@/components/ui';
import type { QuickReply } from '@crm-lab/shared';

/**
 * Menu de respostas rápidas do Composer — COMPONENTS.md (`conversation/`),
 * Onda 8 §3.4.
 *
 * Componente burro: recebe a lista e o filtro, devolve a escolha. Não busca
 * nada e não conhece a `/` — quem decide QUANDO abrir é o `Composer`, porque a
 * regra ("só com o campo vazio") é sobre o campo, não sobre o menu.
 *
 * O foco NUNCA sai do textarea: quem está digitando `/jej` continua digitando.
 * Por isso a navegação é `aria-activedescendant` sobre um `listbox` e não
 * `focus()` item a item — mover o foco real tiraria o cursor do campo e a
 * próxima tecla iria para o lugar errado.
 */

export interface QuickReplyMenuProps {
  items: readonly QuickReply[];
  /** Texto digitado depois da `/` (sem a barra). */
  filter: string;
  /** Índice do item ativo, controlado pelo Composer (setas). */
  activeIndex: number;
  onPick: (reply: QuickReply) => void;
}

/** Id estável do item ativo — é o alvo do `aria-activedescendant`. */
export function quickReplyOptionId(id: string): string {
  return `quick-reply-option-${id}`;
}

/** Filtra por atalho, sem caixa. Fonte única: o Composer usa a MESMA função. */
export function filterQuickReplies(
  items: readonly QuickReply[],
  filter: string,
): readonly QuickReply[] {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return items;
  return items.filter((item) => item.shortcut.includes(needle));
}

export function QuickReplyMenu({ items, filter, activeIndex, onPick }: QuickReplyMenuProps) {
  const visible = useMemo(() => filterQuickReplies(items, filter), [items, filter]);

  if (visible.length === 0) return null;

  return (
    <ul
      id="quick-reply-listbox"
      role="listbox"
      aria-label="Respostas rápidas"
      className={cn(
        'absolute bottom-full left-0 z-50 mb-xs max-h-[240px] w-full overflow-y-auto',
        'list-none rounded-md border border-neutral-200 bg-surface p-xs shadow-md',
      )}
    >
      {visible.map((reply, index) => (
        <li key={reply.id}>
          <button
            id={quickReplyOptionId(reply.id)}
            role="option"
            type="button"
            aria-selected={index === activeIndex}
            // `onMouseDown` e não `onClick`: o clique tira o foco do textarea
            // antes do `click` disparar, e o menu fecharia no blur sem escolher.
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(reply);
            }}
            className={cn(
              'flex w-full cursor-pointer flex-col items-start gap-[2px] rounded-sm border-none',
              'px-sm py-xs text-left font-body',
              index === activeIndex ? 'bg-accent-100' : 'bg-transparent hover:bg-accent-100',
            )}
          >
            <span className="text-label font-medium text-text">
              /{reply.shortcut}
              <span className="ml-sm font-normal text-neutral-600">{reply.title}</span>
            </span>
            <span className="line-clamp-1 text-caption text-neutral-600">{reply.content}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
