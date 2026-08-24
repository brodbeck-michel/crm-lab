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
});
