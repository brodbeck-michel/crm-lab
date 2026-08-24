import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SegmentedControl } from './SegmentedControl';

const options = [
  { value: 'particular', label: 'Particular' },
  { value: 'convenio', label: 'Convênio' },
  { value: 'pacote', label: 'Pacote' },
];

describe('SegmentedControl', () => {
  it('marca a opção ativa com aria-selected', () => {
    render(<SegmentedControl options={options} value="convenio" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Convênio' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Particular' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('troca de valor por clique', async () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={options} value="particular" onChange={onChange} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Pacote' }));
    expect(onChange).toHaveBeenCalledWith('pacote');
  });

  it('troca de valor pelas setas do teclado', async () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={options} value="particular" onChange={onChange} />);

    const active = screen.getByRole('tab', { name: 'Particular' });
    active.focus();

    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('convenio');
  });

  it('a seta para a esquerda circula para o fim da lista', async () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={options} value="particular" onChange={onChange} />);

    screen.getByRole('tab', { name: 'Particular' }).focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('pacote');
  });

  it('Home e End vão às pontas', async () => {
    const onChange = vi.fn();
    render(<SegmentedControl options={options} value="convenio" onChange={onChange} />);
    screen.getByRole('tab', { name: 'Convênio' }).focus();

    await userEvent.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('pacote');

    await userEvent.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith('particular');
  });

  it('pula opções desabilitadas na navegação por teclado', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B', disabled: true },
          { value: 'c', label: 'C' },
        ]}
        value="a"
        onChange={onChange}
      />,
    );
    screen.getByRole('tab', { name: 'A' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('c');
  });

  it('é um trilho com pílula, não abas sublinhadas', () => {
    render(<SegmentedControl options={options} value="particular" onChange={() => {}} />);
    expect(screen.getByRole('tablist')).toHaveClass('rounded-pill');
    expect(screen.getByRole('tab', { name: 'Particular' })).toHaveClass('rounded-pill');
  });
});
