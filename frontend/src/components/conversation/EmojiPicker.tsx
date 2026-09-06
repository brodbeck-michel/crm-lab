import { useEffect, useRef, useState } from 'react';
import { Button, cn } from '@/components/ui';

/**
 * Seletor de emoji do Composer — COMPONENTS.md (`conversation/`), Onda 8 §2.2.
 *
 * rangel: grade fixa, sem dependência. Um seletor completo com busca por nome
 * custa centenas de KB para um caso que não pede busca. Se a busca virar
 * necessidade real, a biblioteca entra AQUI dentro — o resto da tela não sabe
 * a diferença.
 *
 * Cada emoji é um `<button>` com `aria-label` em pt-BR: leitor de tela sem o
 * rótulo anuncia o codepoint, que não ajuda ninguém. `Esc` fecha e devolve o
 * foco a quem abriu (o `Composer` passa `onClose`).
 */

/** Os 48 do dia a dia de um atendimento de laboratório. */
export const EMOJIS: ReadonlyArray<{ char: string; label: string }> = [
  { char: '😀', label: 'sorriso' },
  { char: '😁', label: 'sorriso animado' },
  { char: '😊', label: 'sorriso tímido' },
  { char: '🙂', label: 'sorriso leve' },
  { char: '😉', label: 'piscadinha' },
  { char: '😅', label: 'sorriso sem graça' },
  { char: '😂', label: 'chorando de rir' },
  { char: '🥰', label: 'apaixonado' },
  { char: '😍', label: 'olhos de coração' },
  { char: '🤗', label: 'abraço' },
  { char: '🤔', label: 'pensando' },
  { char: '😐', label: 'sem expressão' },
  { char: '😴', label: 'dormindo' },
  { char: '😷', label: 'máscara' },
  { char: '🤒', label: 'doente' },
  { char: '🤕', label: 'machucado' },
  { char: '😢', label: 'triste' },
  { char: '😭', label: 'chorando' },
  { char: '😌', label: 'aliviado' },
  { char: '😳', label: 'surpreso' },
  { char: '🙏', label: 'obrigado' },
  { char: '👍', label: 'joinha' },
  { char: '👎', label: 'não curti' },
  { char: '👏', label: 'palmas' },
  { char: '🙌', label: 'comemorando' },
  { char: '🤝', label: 'aperto de mãos' },
  { char: '💪', label: 'força' },
  { char: '✌️', label: 'paz e amor' },
  { char: '👋', label: 'aceno' },
  { char: '❤️', label: 'coração' },
  { char: '💚', label: 'coração verde' },
  { char: '✨', label: 'brilho' },
  { char: '⭐', label: 'estrela' },
  { char: '🎉', label: 'festa' },
  { char: '✅', label: 'confirmado' },
  { char: '❌', label: 'erro' },
  { char: '⚠️', label: 'atenção' },
  { char: '❗', label: 'exclamação' },
  { char: '❓', label: 'interrogação' },
  { char: '📅', label: 'calendário' },
  { char: '⏰', label: 'horário' },
  { char: '📍', label: 'endereço' },
  { char: '📞', label: 'telefone' },
  { char: '📄', label: 'documento' },
  { char: '💳', label: 'pagamento' },
  { char: '💰', label: 'dinheiro' },
  { char: '🩺', label: 'estetoscópio' },
  { char: '🧪', label: 'exame' },
];

export interface EmojiPickerProps {
  /** Recebe o caractere escolhido. O popover fecha sozinho depois. */
  onPick: (emoji: string) => void;
  /** Chamado ao fechar por `Esc`, clique fora ou escolha — devolve o foco. */
  onClose?: () => void;
  disabled?: boolean;
}

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
  const ref = useRef<HTMLDivElement>(null);

  function close(): void {
    setOpen(false);
    onClose?.();
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

  return (
    <div ref={ref} className="relative flex-[0_0_auto]">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Inserir emoji"
      >
        <EmojiIcon />
      </Button>

      {open && (
        <div
          className={cn(
            'absolute bottom-full left-0 z-50 mb-xs w-[264px] rounded-md border',
            'border-neutral-200 bg-surface p-sm shadow-md',
          )}
        >
          <div className="grid grid-cols-8 gap-xs">
            {EMOJIS.map((emoji, index) => (
              <button
                // O mesmo caractere pode repetir com rótulos diferentes.
                key={`${emoji.char}-${index}`}
                type="button"
                aria-label={emoji.label}
                onClick={() => {
                  onPick(emoji.char);
                  close();
                }}
                className="cursor-pointer rounded-sm border-none bg-transparent p-xs text-label leading-none hover:bg-accent-100"
              >
                {emoji.char}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
