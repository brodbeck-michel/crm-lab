import type { InputProps } from '@/components/ui';
import { Input } from '@/components/ui';
import { ninthDigitSuggestion } from '@/lib/phone-suggestion';

export interface PhoneFieldProps extends Omit<InputProps, 'value' | 'onChange' | 'type'> {
  value: string;
  onChange: (value: string) => void;
}

/**
 * Campo de telefone com a sugestão do nono dígito (CRMLAB-121, D-287) —
 * usado no "Novo contato" e na "Nova conversa".
 *
 * Número de celular com 8 dígitos ganha, logo abaixo, a sugestão com o 9 e um
 * botão "Usar". É sugestão, não correção: o número antigo continua aceito
 * (o servidor casa os dois formatos, D-176) — por isso não vira erro.
 */
export function PhoneField({ value, onChange, error, ...rest }: PhoneFieldProps) {
  const suggestion = error ? null : ninthDigitSuggestion(value);

  return (
    <div className="flex flex-col gap-xs">
      <Input
        type="tel"
        inputMode="tel"
        autoComplete="off"
        placeholder="(48) 99999-1234"
        maxLength={20}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        error={error}
        {...rest}
      />
      {suggestion && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-sm rounded-md bg-accent-100 px-sm py-xs font-body text-caption text-text"
        >
          <span>
            Celular sem o 9? Sugestão: <strong className="tabular-nums">{suggestion}</strong>
          </span>
          <button
            type="button"
            className="font-semibold text-text underline underline-offset-2"
            onClick={() => onChange(suggestion)}
          >
            Usar
          </button>
        </p>
      )}
    </div>
  );
}
