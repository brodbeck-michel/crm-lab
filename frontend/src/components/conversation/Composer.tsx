import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { QuickReply } from '@crm-lab/shared';
import { Button, cn } from '@/components/ui';
import { EmojiPicker } from './EmojiPicker';
import { QuickReplyMenu, filterQuickReplies, quickReplyOptionId } from './QuickReplyMenu';

/**
 * Composer — COMPONENTS.md (`conversation/`):
 * campo pílula + botão de anexo + botão enviar (primary).
 *
 * **Enter envia, Shift+Enter quebra linha.** O campo é um `<textarea>` de uma
 * linha justamente para que Shift+Enter produza quebra de verdade; o visual
 * continua sendo a pílula do design system (999px, DESIGN_TOKENS.md).
 *
 * Componente burro: não conhece a API. Quem monta a tela passa `onSend`.
 *
 * **O campo cresce com o texto** (CRMLAB-49, padrão WhatsApp Web): começa com
 * uma linha, ganha altura a cada quebra até `FIELD_MAX_HEIGHT_PX` e dali em
 * diante rola por dentro. Passou de uma linha, a pílula vira `radius-md` — o
 * raio de campo multilinha do DESIGN_TOKENS.md (999px deforma com 3 linhas).
 *
 * O emoji entra NA POSIÇÃO DO CURSOR (Onda 8 §2.2): quem escreve "bom dia,
 * tudo bem?" e volta o cursor para o meio não quer o emoji no fim da frase.
 *
 * As respostas rápidas (Onda 8 §3.4) abrem com `/` **e o campo vazio**. Em
 * qualquer `/` o menu atrapalharia quem escreve "km/h", "24/48h" ou uma URL —
 * e essa restrição é o que torna a funcionalidade invisível para quem não a
 * está usando.
 */

export interface ComposerProps {
  /** Recebe o texto já aparado. Não é chamado com string vazia. */
  onSend: (content: string) => void;
  /** Anexo — sem handler, o botão não aparece (nada de botão morto). */
  onAttach?: () => void;
  /**
   * Texto inicial do campo (ex.: "Enviar orçamento" chegando com a mensagem
   * pronta). Só semeia o estado no MOUNT — o Composer continua dono do que
   * a pessoa digita depois, sem virar componente controlado.
   */
  initialValue?: string;
  /** Conversa arquivada / sem permissão de escrita. */
  disabled?: boolean;
  /** Envio em voo: bloqueia o botão e mostra o indicador. */
  sending?: boolean;
  placeholder?: string;
  /**
   * Macros do laboratório (`GET /quick-replies`). Lista vazia ou ausente: a
   * `/` é só uma barra. O Composer não busca nada — quem monta a tela é dono
   * da chamada.
   */
  quickReplies?: readonly QuickReply[];
}

/**
 * Teto do crescimento: ~6 linhas de `text-label`. Passou disso, rolagem interna.
 * Não é CSS puro (`field-sizing: content`) porque o Firefox não suporta.
 */
const FIELD_MAX_HEIGHT_PX = 150;

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
  quickReplies,
  initialValue,
}: ComposerProps) {
  const [value, setValue] = useState(initialValue ?? '');
  // `false` enquanto a pessoa não abriu o menu nesta digitação — é o que faz
  // `Esc` deixar a `/` no campo sem o menu voltar a abrir sozinho.
  const [macroMenuOpen, setMacroMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [multiline, setMultiline] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const blocked = disabled || sending;

  /**
   * Altura acompanha o conteúdo. Depende de `value`, não do `onChange`: assim
   * emoji, resposta rápida, envio (volta a '') e `initialValue` recalculam
   * pelo mesmo caminho. `auto` antes de medir é o que deixa o campo DIMINUIR.
   * Layout effect para não pintar um quadro com a altura velha.
   */
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = 'auto';
    const singleLine = field.clientHeight;
    // `scrollHeight` não conta a borda e o preflight usa `border-box`: sem
    // somá-la, o campo fica 2px curto e aparece rolagem já na 1ª linha.
    const border = field.offsetHeight - field.clientHeight;
    const content = field.scrollHeight + border;
    field.style.height = `${Math.min(content, FIELD_MAX_HEIGHT_PX)}px`;
    field.style.overflowY = content > FIELD_MAX_HEIGHT_PX ? 'auto' : 'hidden';
    setMultiline(field.scrollHeight > singleLine);
  }, [value]);

  /** O texto é um comando de macro enquanto for `/` + o que se digita depois. */
  const macroFilter = value.startsWith('/') ? value.slice(1) : null;
  const macroMatches = useMemo(
    () =>
      macroMenuOpen && macroFilter !== null
        ? filterQuickReplies(quickReplies ?? [], macroFilter)
        : [],
    [macroMenuOpen, macroFilter, quickReplies],
  );
  const macroOpen = macroMatches.length > 0;
  const activeMacro = macroMatches[Math.min(activeIndex, macroMatches.length - 1)];

  /** Escolher SUBSTITUI o texto: o comando `/atalho` não faz parte da resposta. */
  function pickMacro(reply: QuickReply): void {
    setValue(reply.content);
    setMacroMenuOpen(false);
    setActiveIndex(0);
    fieldRef.current?.focus();
  }

  function handleChange(next: string): void {
    setValue(next);
    setActiveIndex(0);
    // Abre só quando a `/` é o texto INTEIRO — ou seja, campo vazio antes dela.
    if (next === '/') setMacroMenuOpen(true);
    // Apagou a barra: o comando acabou, e digitar `/` de novo recomeça.
    else if (!next.startsWith('/')) setMacroMenuOpen(false);
  }

  function submit(): void {
    const content = value.trim();
    if (!content || blocked) return;
    onSend(content);
    setValue('');
    fieldRef.current?.focus();
  }

  /**
   * Emoji na posição do cursor. `selectionStart/End` do textarea é a fonte —
   * se o campo perdeu o foco (o popover é outro elemento), o navegador mantém
   * a última seleção, que é exatamente onde a pessoa parou de escrever.
   */
  function insertEmoji(emoji: string): void {
    const field = fieldRef.current;
    const start = field?.selectionStart ?? value.length;
    const end = field?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + emoji + value.slice(end);
    setValue(next);
    // O cursor precisa ficar DEPOIS do emoji; o estado só chega ao DOM no
    // próximo frame, por isso o reposicionamento espera o React pintar.
    requestAnimationFrame(() => {
      const caret = start + emoji.length;
      fieldRef.current?.setSelectionRange(caret, caret);
    });
  }

  /**
   * Ctrl+B / Cmd+B (CRMLAB-51, D-183): envolve a seleção em `*` — o negrito do
   * WhatsApp — e mantém o texto selecionado; sem seleção, `**` com o cursor no meio.
   */
  function wrapBold(): void {
    const field = fieldRef.current;
    const start = field?.selectionStart ?? value.length;
    const end = field?.selectionEnd ?? value.length;
    setValue(`${value.slice(0, start)}*${value.slice(start, end)}*${value.slice(end)}`);
    requestAnimationFrame(() => fieldRef.current?.setSelectionRange(start + 1, end + 1));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      wrapBold();
      return;
    }
    if (macroOpen) {
      // Com o menu aberto, estas teclas pertencem a ELE. Enter escolhendo a
      // macro é o ponto: enviar `/jej` como mensagem seria enviar o comando.
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((index) => {
          const next = index + step;
          if (next < 0) return macroMatches.length - 1;
          if (next >= macroMatches.length) return 0;
          return next;
        });
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (activeMacro) pickMacro(activeMacro);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        // A `/` FICA no campo: fechar o menu não pode apagar o que a pessoa
        // digitou — ela pode estar começando "/dia sim /dia não".
        setMacroMenuOpen(false);
        return;
      }
    }

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

      <EmojiPicker
        onPick={insertEmoji}
        onClose={() => fieldRef.current?.focus()}
        disabled={blocked}
      />

      <div className="relative flex min-w-0 flex-1">
        {macroOpen && macroFilter !== null && (
          <QuickReplyMenu
            items={quickReplies ?? []}
            filter={macroFilter}
            activeIndex={Math.min(activeIndex, macroMatches.length - 1)}
            onPick={pickMacro}
          />
        )}
        <textarea
          ref={fieldRef}
          rows={1}
          value={value}
          disabled={blocked}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label="Mensagem"
          role={macroOpen ? 'combobox' : undefined}
          aria-expanded={macroOpen || undefined}
          aria-controls={macroOpen ? 'quick-reply-listbox' : undefined}
          aria-activedescendant={
            macroOpen && activeMacro ? quickReplyOptionId(activeMacro.id) : undefined
          }
          className={cn(
            'min-h-[36px] w-full min-w-0 flex-1 resize-none border border-neutral-300 bg-bg',
            multiline ? 'rounded-md' : 'rounded-pill',
            'px-lg py-[9px] font-body text-label text-text outline-none',
            'placeholder:text-neutral-600 focus:border-accent disabled:cursor-not-allowed disabled:opacity-60',
          )}
        />
      </div>

      <Button onClick={submit} loading={sending} disabled={disabled || value.trim().length === 0}>
        Enviar
      </Button>
    </div>
  );
}
