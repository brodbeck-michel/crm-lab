import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DateDisplay } from './DateDisplay';

describe('DateDisplay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('relativo é o padrão (listas)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T14:30:00.000Z'));
    render(<DateDisplay value="2026-08-23T14:26:00.000Z" />);
    expect(screen.getByText('há 4 min')).toBeInTheDocument();
  });

  it('absoluto mostra data e hora (detalhes)', () => {
    const local = new Date(2026, 7, 23, 14, 30, 0);
    render(<DateDisplay value={local.toISOString()} variant="absolute" />);
    expect(screen.getByText('23/08/2026 14:30')).toBeInTheDocument();
  });

  it('no modo relativo o absoluto fica no title', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 23, 14, 30, 0));
    const local = new Date(2026, 7, 23, 14, 26, 0);
    render(<DateDisplay value={local.toISOString()} />);
    expect(screen.getByText('há 4 min')).toHaveAttribute('title', '23/08/2026 14:26');
  });

  it('usa <time> com dateTime, e nunca quebra linha', () => {
    const iso = '2026-08-23T14:30:00.000Z';
    const { container } = render(<DateDisplay value={iso} variant="absolute" />);
    const time = container.querySelector('time');
    expect(time).toHaveAttribute('datetime', iso);
    expect(time).toHaveClass('whitespace-nowrap');
  });
});
