import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Badge } from './Badge';
import { Input } from './Input';
import { TextArea } from './TextArea';
import { Select } from './Select';
import { Toggle } from './Toggle';
import { Tooltip } from './Tooltip';

describe('Input', () => {
  it('associa o rótulo ao campo', () => {
    render(<Input label="Telefone" />);
    expect(screen.getByLabelText('Telefone')).toBeInTheDocument();
  });

  it('digita e propaga onChange', async () => {
    const onChange = vi.fn();
    render(<Input label="Nome" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText('Nome'), 'ab');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('erro marca aria-invalid e anuncia por role=alert', () => {
    render(<Input label="E-mail" error="E-mail inválido" />);
    expect(screen.getByLabelText('E-mail')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('E-mail inválido');
  });

  it('disabled impede digitação', async () => {
    const onChange = vi.fn();
    render(<Input label="Nome" disabled onChange={onChange} />);
    await userEvent.type(screen.getByLabelText('Nome'), 'x');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('TextArea', () => {
  it('campo multilinha usa radius-md, nunca pílula', () => {
    render(<TextArea label="Nota interna" />);
    const field = screen.getByLabelText('Nota interna');
    expect(field).toHaveClass('rounded-md');
    expect(field).not.toHaveClass('rounded-pill');
  });
});

describe('Badge', () => {
  it('mostra a contagem', () => {
    render(<Badge count={3} />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('não renderiza com contagem zero', () => {
    const { container } = render(<Badge count={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('trunca acima do máximo', () => {
    render(<Badge count={150} />);
    expect(screen.getByText('99+')).toBeInTheDocument();
  });
});

describe('Select', () => {
  const options = [
    { value: 'preco', label: 'Preço' },
    { value: 'silencio', label: 'Silêncio' },
  ];

  it('renderiza as opções e o placeholder', () => {
    render(<Select label="Motivo" options={options} placeholder="Selecione" defaultValue="" />);
    expect(screen.getByRole('option', { name: 'Selecione' })).toBeDisabled();
    expect(screen.getByRole('option', { name: 'Preço' })).toBeInTheDocument();
  });

  it('troca de valor', async () => {
    const onChange = vi.fn();
    render(<Select label="Motivo" options={options} defaultValue="preco" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText('Motivo'), 'silencio');
    expect(onChange).toHaveBeenCalled();
  });
});

describe('Toggle', () => {
  it('expõe role=switch com o estado', () => {
    render(<Toggle checked onChange={() => {}} label="Notificações" />);
    expect(screen.getByRole('switch', { name: 'Notificações' })).toBeChecked();
  });

  it('inverte o valor ao clicar', async () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Notificações" />);
    await userEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('não dispara quando disabled', async () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} disabled onChange={onChange} label="Notificações" />);
    await userEvent.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Tooltip', () => {
  it('aparece no hover e some ao sair', async () => {
    render(
      <Tooltip content="Limite de desconto do perfil">
        <button type="button">Info</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await userEvent.hover(screen.getByRole('button', { name: 'Info' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Limite de desconto do perfil');

    await userEvent.unhover(screen.getByRole('button', { name: 'Info' }));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('aparece também no foco de teclado', async () => {
    render(
      <Tooltip content="Dica">
        <button type="button">Info</button>
      </Tooltip>,
    );
    await userEvent.tab();
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });
});
