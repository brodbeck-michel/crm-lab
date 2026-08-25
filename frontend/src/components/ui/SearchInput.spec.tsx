import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SearchInput } from './SearchInput';

/**
 * Timers falsos: o ponto do teste é PROVAR que nada é emitido antes do
 * debounce. `fireEvent.change` emite um `change` por chamada — é o mesmo
 * efeito de digitar, sem depender do agendador do user-event.
 */
describe('SearchInput', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const type = (text: string) => {
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: text } });
  };

  const tick = (ms: number) => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };

  it('não emite na montagem', () => {
    const onSearch = vi.fn();
    render(<SearchInput onSearch={onSearch} />);
    tick(1000);
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('só emite depois do debounce de 300ms', () => {
    const onSearch = vi.fn();
    render(<SearchInput onSearch={onSearch} />);

    type('hemo');
    expect(onSearch).not.toHaveBeenCalled();

    tick(299);
    expect(onSearch).not.toHaveBeenCalled();

    tick(1);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('hemo');
  });

  it('teclas em sequência geram uma única chamada, com o termo final', () => {
    const onSearch = vi.fn();
    render(<SearchInput onSearch={onSearch} />);

    type('t');
    tick(100);
    type('ts');
    tick(100);
    type('tsh');
    expect(onSearch).not.toHaveBeenCalled();

    tick(300);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('tsh');
  });

  it('respeita um debounce customizado', () => {
    const onSearch = vi.fn();
    render(<SearchInput onSearch={onSearch} debounceMs={800} />);

    type('a');
    tick(300);
    expect(onSearch).not.toHaveBeenCalled();

    tick(500);
    expect(onSearch).toHaveBeenCalledWith('a');
  });

  it('limpar o campo também é emitido, para que a lista volte ao normal', () => {
    const onSearch = vi.fn();
    render(<SearchInput defaultValue="tsh" onSearch={onSearch} />);

    type('');
    tick(300);
    expect(onSearch).toHaveBeenCalledWith('');
  });

  /**
   * Regressão do defeito que derrubava a paginação de `/catalog`.
   *
   * No `StrictMode` o React 18 monta o efeito, limpa e monta de novo. O guard
   * antigo (`isFirstRun` desarmado dentro do efeito) valia `false` na segunda
   * invocação, então um `onSearch('')` FANTASMA saía 300ms depois — e o
   * `Catalog.handleSearch` chamava `goToPage(1)`, apagando o `?page=2` da URL.
   *
   * `render` do Testing Library NÃO usa `StrictMode` por padrão: sem envolver
   * explicitamente, o teste ficaria verde com o bug em pé.
   */
  describe('sob StrictMode (efeito invocado duas vezes na montagem)', () => {
    const renderStrict = (props: Parameters<typeof SearchInput>[0]) =>
      render(
        <StrictMode>
          <SearchInput {...props} />
        </StrictMode>,
      );

    it('não emite nada na montagem', () => {
      const onSearch = vi.fn();
      renderStrict({ onSearch });

      tick(1000);
      expect(onSearch).not.toHaveBeenCalled();
    });

    it('não emite o termo inicial na montagem quando há `defaultValue`', () => {
      const onSearch = vi.fn();
      renderStrict({ defaultValue: 'tsh', onSearch });

      tick(1000);
      expect(onSearch).not.toHaveBeenCalled();
    });

    it('continua emitindo o que o usuário digita', () => {
      const onSearch = vi.fn();
      renderStrict({ onSearch });

      type('hemo');
      tick(300);

      expect(onSearch).toHaveBeenCalledTimes(1);
      expect(onSearch).toHaveBeenCalledWith('hemo');
    });

    it('continua emitindo quando o usuário limpa o campo', () => {
      const onSearch = vi.fn();
      renderStrict({ defaultValue: 'tsh', onSearch });

      type('');
      tick(300);

      expect(onSearch).toHaveBeenCalledTimes(1);
      expect(onSearch).toHaveBeenCalledWith('');
    });
  });
});
