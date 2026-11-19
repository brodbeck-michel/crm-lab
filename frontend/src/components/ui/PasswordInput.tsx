import { forwardRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from './Input';
import type { InputProps } from './Input';

export type PasswordInputProps = Omit<InputProps, 'type' | 'suffix'>;

/**
 * Campo de senha/segredo (CRMLAB-185). É o `Input` com:
 * - botão "olho" para mostrar/ocultar o valor — começa sempre oculto;
 * - aviso "Caps Lock está ligado" enquanto o campo tem foco e o Caps Lock está ativo.
 *
 * O estado do Caps Lock só é conhecido depois de um evento de teclado/mouse
 * (`getModifierState`) — por isso é lido em keydown/keyup e zerado no blur.
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { onKeyDown, onKeyUp, onBlur, disabled, ...rest },
  ref,
) {
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

  const readCapsLock = (event: KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(event.getModifierState('CapsLock'));
  };

  const toggle = (
    <button
      type="button"
      onClick={() => setVisible((v) => !v)}
      disabled={disabled}
      aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}
      aria-pressed={visible}
      title={visible ? 'Ocultar senha' : 'Mostrar senha'}
      className="flex items-center rounded-pill text-neutral-600 outline-none hover:text-text focus-visible:text-accent disabled:cursor-not-allowed"
    >
      {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
    </button>
  );

  return (
    <div className="flex w-full flex-col gap-xs">
      <Input
        {...rest}
        ref={ref}
        type={visible ? 'text' : 'password'}
        disabled={disabled}
        suffix={toggle}
        onKeyDown={(event) => {
          readCapsLock(event);
          onKeyDown?.(event);
        }}
        onKeyUp={(event) => {
          readCapsLock(event);
          onKeyUp?.(event);
        }}
        onBlur={(event: FocusEvent<HTMLInputElement>) => {
          setCapsLock(false);
          onBlur?.(event);
        }}
      />
      {capsLock && (
        <span role="status" className="font-body text-caption font-semibold text-neutral-700">
          Caps Lock está ligado
        </span>
      )}
    </div>
  );
});
