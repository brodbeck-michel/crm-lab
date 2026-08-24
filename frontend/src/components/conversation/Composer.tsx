import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button, cn } from '@/components/ui';

/**
 * Composer — COMPONENTS.md (`conversation/`):
 * campo pílula + botão de anexo + botão enviar (primary).
 *
 * **Enter envia, Shift+Enter quebra linha.** O campo é um `<textarea>` de uma
 * linha justamente para que Shift+Enter produza quebra de verdade; o visual
 * continua sendo a pílula do design system (999px, DESIGN_TOKENS.md).
 *
 * Componente burro: não conhece a API. Quem monta a tela passa `onSend`.
 */

export interface ComposerProps {
  /** Recebe o texto já aparado. Não é chamado com string vazia. */
  onSend: (content: string) => void;
  /** Anexo — sem handler, o botão não aparece (nada de botão morto). */
  onAttach?: () => void;
  /** Conversa arquivada / sem permissão de escrita. */
  disabled?: boolean;
  /** Envio em voo: bloqueia o botão e mostra o indicador. */
  sending?: boolean;
  placeholder?: string;
}

/** Clipe de papel em SVG inline — sem biblioteca de ícones (padrão do shell). */
function AttachIcon() {
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
      <path d="M10.5 4.5 5.7 9.3a1.7 1.7 0 0 0 2.4 2.4l5-5a3.2 3.2 0 0 0-4.5-4.5l-5 5a4.7 4.7 0 0 0 6.6 6.6l4.1-4.1" />
    </svg>
  );
}

export function Composer({
  onSend,
  onAttach,
  disabled = false,
  sending = false,
  placeholder = 'Escreva uma mensagem',
}: ComposerProps) {
  const [value, setValue] = useState('');
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const blocked = disabled || sending;

  function submit(): void {
    const content = value.trim();
    if (!content || blocked) return;
    onSend(content);
    setValue('');
    fieldRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Shift+Enter cai no comportamento padrão do textarea: quebra de linha.
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submit();
  }

  return (
    <div
      data-testid="composer"
      className="flex items-end gap-sm border-t border-neutral-300 bg-bg px-lg py-md"
    >
      {onAttach && (
        <Button
          variant="secondary"
          size="sm"
          onClick={onAttach}
          disabled={blocked}
          aria-label="Anexar arquivo"
        >
          <AttachIcon />
        </Button>
      )}

      <textarea
        ref={fieldRef}
        rows={1}
        value={value}
        disabled={blocked}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        aria-label="Mensagem"
        className={cn(
          'min-h-[36px] min-w-0 flex-1 resize-none rounded-pill border border-neutral-300 bg-bg',
          'px-lg py-[9px] font-body text-label text-text outline-none',
          'placeholder:text-neutral-600 focus:border-accent disabled:cursor-not-allowed disabled:opacity-60',
        )}
      />

      <Button onClick={submit} loading={sending} disabled={disabled || value.trim().length === 0}>
        Enviar
      </Button>
    </div>
  );
}
