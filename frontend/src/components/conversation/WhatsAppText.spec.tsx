import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WhatsAppText } from './WhatsAppText';

/** WhatsAppText — D-242: formatação como nós React, links em nova aba, HTML como texto. */

function renderText(text: string) {
  return render(
    <p data-testid="bubble" className="whitespace-pre-wrap">
      <WhatsAppText text={text} />
    </p>,
  );
}

describe('WhatsAppText', () => {
  it('negrito, itálico, tachado e mono sem mostrar os símbolos', () => {
    renderText('*a* _b_ ~c~ ```d``` `e`');
    const bubble = screen.getByTestId('bubble');
    expect(bubble.textContent).toBe('a b c d e');
    expect(bubble.querySelector('strong')?.textContent).toBe('a');
    expect(bubble.querySelector('em')?.textContent).toBe('b');
    expect(bubble.querySelector('s')?.textContent).toBe('c');
    expect(bubble.querySelector('[data-format="mono"]')?.textContent).toBe('d');
    expect(bubble.querySelector('[data-format="code"]')?.textContent).toBe('e');
  });

  it('link abre em nova aba com rel="noopener noreferrer"', () => {
    renderText('resultado em www.lab.com.br/r_1 ok');
    const link = screen.getByRole('link', { name: 'www.lab.com.br/r_1' });
    expect(link).toHaveAttribute('href', 'https://www.lab.com.br/r_1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('`<script>` e HTML aparecem como texto, sem virar elemento', () => {
    const text = '<script>alert(1)</script><img src=x onerror="alert(2)"><b>oi</b>';
    renderText(text);
    const bubble = screen.getByTestId('bubble');
    expect(bubble.textContent).toBe(text);
    expect(bubble.querySelector('script, img, b')).toBeNull();
  });

  it('quebra de linha só entre linhas comuns; citação e lista são blocos', () => {
    renderText('oi\ntudo bem?\n> citado\n- item\n1. primeiro');
    const bubble = screen.getByTestId('bubble');
    expect(bubble.querySelector('[data-format="quote"]')?.textContent).toBe('citado');
    expect(bubble.querySelector('[data-format="bullet"]')?.textContent).toBe('• item');
    expect(bubble.querySelector('[data-format="numbered"]')?.textContent).toBe('1. primeiro');
    expect(bubble.textContent).toBe('oi\ntudo bem?citado• item1. primeiro');
  });
});
