import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/components/ui/cn';

export interface ModalProps {
  open: boolean;
  /** Chamado por ×, Esc e clique no backdrop. */
  onClose: () => void;
  /** Título do cartão — vira o `aria-label` do diálogo. */
  title: string;
  children: ReactNode;
  /** Linha de ações no rodapé (primárias à esquerda, positiva à direita). */
  footer?: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal: backdrop translúcido escuro, cartão `--radius-lg` + `--shadow-lg`,
 * largura máxima 720px, rolagem interna.
 *
 * Fecha por ×, Esc e clique fora. O cartão faz `stopPropagation`, então
 * clicar DENTRO nunca fecha. O foco fica preso no cartão enquanto aberto
 * e volta ao elemento anterior ao fechar.
 */
export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  /**
   * `onClose` numa ref: a maioria dos chamadores passa uma arrow inline, que
   * ganha identidade nova a cada render. Se ela entrasse nas dependências do
   * efeito abaixo, o efeito re-rodaria a cada tecla e `card.focus()` roubaria
   * o foco de um input dentro do modal — só o 1º caractere sobreviveria.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const trapFocus = useCallback((event: KeyboardEvent) => {
    const card = cardRef.current;
    if (!card) return;

    const nodes = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) {
      event.preventDefault();
      card.focus();
      return;
    }

    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) return;

    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === card)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
      } else if (event.key === 'Tab') {
        trapFocus(event);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus();
    };
    // `onClose` NÃO entra aqui de propósito (ver `onCloseRef` acima): o foco
    // inicial acontece UMA vez por abertura, não a cada render.
  }, [open, trapFocus]);

  if (!open) return null;

  return (
    <div
      data-testid="modal-backdrop"
      onClick={onClose}
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-backdrop p-lg',
      )}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid="modal-card"
        onClick={(event) => event.stopPropagation()}
        className={cn(
          'flex max-h-[86vh] w-full max-w-modal flex-col overflow-hidden',
          'rounded-lg bg-neutral-100 shadow-lg outline-none',
        )}
      >
        <header className="flex flex-[0_0_auto] items-center gap-md border-b border-neutral-300 px-xl py-lg">
          <h2 className="min-w-0 flex-1 font-heading">{title}</h2>
          <button
            type="button"
            aria-label="Fechar"
            onClick={onClose}
            className={cn(
              'flex h-[28px] w-[28px] flex-[0_0_28px] cursor-pointer items-center justify-center',
              'rounded-pill border-none bg-transparent font-body text-neutral-700 hover:bg-neutral-200',
            )}
          >
            ×
          </button>
        </header>

        {/* Rolagem interna: o cartão nunca cresce além de 86vh. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-xl py-lg font-body text-body">
          {children}
        </div>

        {footer && (
          <footer className="flex flex-[0_0_auto] items-center gap-sm border-t border-neutral-300 px-xl py-lg">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
