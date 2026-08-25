import { useEffect, useRef, useState } from 'react';
import { Input } from './Input';

export interface SearchInputProps {
  /** Valor inicial do campo (não controlado — o debounce é interno). */
  defaultValue?: string;
  placeholder?: string;
  /** Disparado SÓ depois do debounce, com o texto já estabilizado. */
  onSearch: (term: string) => void;
  /** Atraso em ms. Padrão 300 (COMPONENTS.md). */
  debounceMs?: number;
  disabled?: boolean;
  'aria-label'?: string;
}

/** Lupa em SVG inline — sem dependência de biblioteca de ícones. */
function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      focusable="false"
      className="flex-[0_0_14px]"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 L14 14" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Campo de busca com ícone e debounce de 300ms.
 * O `onSearch` NÃO dispara a cada tecla — só quando o usuário para de digitar.
 */
export function SearchInput({
  defaultValue = '',
  placeholder = 'Buscar',
  onSearch,
  debounceMs = 300,
  disabled = false,
  'aria-label': ariaLabel = 'Buscar',
}: SearchInputProps) {
  const [term, setTerm] = useState(defaultValue);
  const onSearchRef = useRef(onSearch);
  /**
   * Guarda de montagem. A versão anterior era um `isFirstRun` desarmado DENTRO
   * do efeito: no `StrictMode` do React 18 o efeito da montagem é invocado,
   * limpo e invocado de novo — na segunda invocação o ref já valia `false`, o
   * `setTimeout` era agendado e um `onSearch(defaultValue)` FANTASMA saía 300ms
   * depois da tela abrir. Quem escutava reagia como se o usuário tivesse
   * buscado: `/catalog?page=2` voltava sozinha para a página 1.
   *
   * O guard agora é armado pelo próprio evento do usuário (`onChange`), não
   * pela contagem de execuções do efeito — quantas vezes o efeito roda na
   * montagem deixa de importar. O contrato público não muda: nada é emitido na
   * montagem, tudo o que o usuário digita (inclusive limpar o campo) é.
   */
  const userTyped = useRef(false);

  useEffect(() => {
    onSearchRef.current = onSearch;
  }, [onSearch]);

  useEffect(() => {
    // Não emite na montagem: só quando o usuário mexe.
    if (!userTyped.current) return;
    const id = setTimeout(() => onSearchRef.current(term), debounceMs);
    return () => clearTimeout(id);
  }, [term, debounceMs]);

  return (
    <Input
      type="search"
      role="searchbox"
      aria-label={ariaLabel}
      placeholder={placeholder}
      disabled={disabled}
      value={term}
      prefix={<SearchIcon />}
      onChange={(event) => {
        userTyped.current = true;
        setTerm(event.target.value);
      }}
    />
  );
}
