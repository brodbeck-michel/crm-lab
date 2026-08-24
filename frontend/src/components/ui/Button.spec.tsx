import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';

describe('Button', () => {
  it('dispara onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Enviar</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('não dispara quando disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Enviar
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('não dispara quando loading, e anuncia aria-busy', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Enviar
      </Button>,
    );
    const button = screen.getByRole('button', { name: /Enviar/ });
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('button-spinner')).toBeInTheDocument();
  });

  it('primary usa fundo accent', () => {
    render(<Button variant="primary">Ok</Button>);
    expect(screen.getByRole('button')).toHaveClass('bg-accent');
  });

  it('secondary usa contorno neutro e fundo transparente', () => {
    render(<Button variant="secondary">Ok</Button>);
    const button = screen.getByRole('button');
    expect(button).toHaveClass('border-neutral-400');
    expect(button).toHaveClass('bg-transparent');
  });

  it('confirmation usa accent-2 (reservado a positivo)', () => {
    render(<Button variant="confirmation">Marcar ganho</Button>);
    expect(screen.getByRole('button')).toHaveClass('bg-accent2');
  });

  it('destructive é fantasma em accent-700', () => {
    render(<Button variant="destructive">Remover</Button>);
    const button = screen.getByRole('button');
    expect(button).toHaveClass('text-accent-700');
    expect(button).toHaveClass('bg-transparent');
  });

  it('é sempre pílula e tem 36px de altura mínima em md', () => {
    render(<Button>Ok</Button>);
    const button = screen.getByRole('button');
    expect(button).toHaveClass('rounded-pill');
    expect(button).toHaveClass('min-h-[36px]');
  });

  it('tem type="button" por padrão, para não submeter formulário sem querer', () => {
    render(<Button>Ok</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });
});
