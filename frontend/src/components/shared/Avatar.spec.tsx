import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Avatar } from './Avatar';

describe('Avatar', () => {
  it('mostra as iniciais do primeiro e último nome', () => {
    render(<Avatar name="Marina Alves" />);
    expect(screen.getByText('MA')).toBeInTheDocument();
  });

  it('nunca comprime: flex 0 0 <size> com o tamanho pedido', () => {
    render(<Avatar name="Marina Alves" size={48} />);
    const avatar = screen.getByText('MA');
    expect(avatar).toHaveStyle({ flex: '0 0 48px', width: '48px', height: '48px' });
  });

  it('usa 36px por padrão', () => {
    render(<Avatar name="Marina Alves" />);
    expect(screen.getByText('MA')).toHaveStyle({ flex: '0 0 36px' });
  });

  it('é sempre redondo e usa a rampa do accent-2', () => {
    render(<Avatar name="Marina Alves" />);
    const avatar = screen.getByText('MA');
    expect(avatar).toHaveClass('rounded-pill');
    expect(avatar).toHaveClass('bg-accent2-200');
  });
});
