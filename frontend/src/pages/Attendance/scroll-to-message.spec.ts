import { afterEach, describe, expect, it, vi } from 'vitest';
import { HIGHLIGHT_MS, scrollToMessage } from './scroll-to-message';

/** "Rolar até a original" (CRMLAB-66, D-221): acha pelo `data-message-id` e destaca. */
describe('scrollToMessage', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('acha o balão, rola até ele e acende o destaque por um instante', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    container.innerHTML = '<div data-anchor-id="a"><div data-message-id="a"></div></div>';
    document.body.appendChild(container);
    const target = container.querySelector<HTMLElement>('[data-message-id="a"]') as HTMLElement;
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;

    expect(scrollToMessage(container, 'a')).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(target.dataset.highlighted).toBe('true');
    vi.advanceTimersByTime(HIGHLIGHT_MS);
    expect(target.dataset.highlighted).toBeUndefined();
  });

  it('original fora do que foi carregado: false (quem chama avisa)', () => {
    const container = document.createElement('div');
    expect(scrollToMessage(container, 'nao-carregada')).toBe(false);
    expect(scrollToMessage(null, 'x')).toBe(false);
  });
});
