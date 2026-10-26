import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Avatar } from './Avatar';
import { PresenceDot } from './PresenceDot';

describe('PresenceDot (CRMLAB-120)', () => {
  it.each([
    ['online', 'Online', 'bg-presence-online'],
    ['busy', 'Ocupado', 'bg-presence-busy'],
    ['away', 'Ausente', 'bg-presence-away'],
    ['offline', 'Offline', 'bg-presence-offline'],
  ] as const)('%s: cor do token e rótulo acessível', (status, label, colorClass) => {
    render(<PresenceDot status={status} />);
    const dot = screen.getByRole('img', { name: `Status: ${label}` });
    expect(dot).toHaveClass(colorClass);
    expect(dot).toHaveAttribute('title', label);
  });

  it('sem status não desenha nada', () => {
    const { container } = render(<PresenceDot status={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Avatar com presence', () => {
  it('põe a bolinha no canto e mantém o avatar sem comprimir', () => {
    render(<Avatar name="Marina Alves" size={40} presence="busy" />);
    const dot = screen.getByRole('img', { name: 'Status: Ocupado' });
    expect(dot).toHaveClass('absolute', 'bottom-0', 'right-0');
    expect(dot).toHaveStyle({ width: '12px' });
    expect(dot.parentElement).toHaveStyle({ flex: '0 0 40px' });
  });

  it('sem presence continua só o círculo', () => {
    render(<Avatar name="Marina Alves" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
