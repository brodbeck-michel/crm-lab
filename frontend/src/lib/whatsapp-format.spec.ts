import { describe, expect, it } from 'vitest';
import { parseWhatsApp, plainText } from './whatsapp-format';
import type { WhatsAppNode } from './whatsapp-format';

/** Formatação padrão WhatsApp — D-183 (negrito) e D-242 (o resto). */

/** Uma linha só: os nós dela. */
const inline = (text: string): WhatsAppNode[] => {
  const lines = parseWhatsApp(text);
  expect(lines).toHaveLength(1);
  return lines[0]?.children ?? [];
};

/** Trechos com a ênfase `type`, em qualquer profundidade. */
function spans(nodes: WhatsAppNode[], type: string): string[] {
  const found: string[] = [];
  for (const node of nodes) {
    if (node.type === type) found.push('children' in node ? plainText(node.children) : node.text);
    if ('children' in node) found.push(...spans(node.children, type));
  }
  return found;
}

const bolds = (text: string) => spans(inline(text), 'bold');

describe('negrito (D-183) — formata', () => {
  it('trecho entre asteriscos vira negrito, o resto fica como está', () => {
    expect(inline('Seu *resultado* saiu')).toEqual([
      { type: 'text', text: 'Seu ' },
      { type: 'bold', children: [{ type: 'text', text: 'resultado' }] },
      { type: 'text', text: ' saiu' },
    ]);
  });

  it('texto inteiro, um caractere e vários trechos na mesma linha', () => {
    expect(bolds('*Olá*')).toEqual(['Olá']);
    expect(bolds('*a*')).toEqual(['a']);
    expect(bolds('*um* e *dois*')).toEqual(['um', 'dois']);
  });

  it('espaço no meio pode; pontuação em volta pode', () => {
    expect(bolds('Atenção: *jejum de 8 horas*.')).toEqual(['jejum de 8 horas']);
    expect(bolds('(*urgente*)')).toEqual(['urgente']);
  });

  it('cada linha formata sozinha', () => {
    const lines = parseWhatsApp('*linha um*\n*linha dois*');
    expect(lines.map((line) => spans(line.children, 'bold'))).toEqual([['linha um'], ['linha dois']]);
  });
});

describe('negrito (D-183) — NÃO formata', () => {
  it.each([
    ['sem asterisco', 'bom dia'],
    ['asterisco solto', 'nota * importante'],
    ['conta com espaços', '2 * 3 * 4'],
    ['conta sem espaços (borda da palavra)', '2*3*4'],
    ['colado em letra por fora', 'a*b*c'],
    ['** vazio', 'isso ** aquilo'],
    ['abertura seguida de espaço', 'x * texto*'],
    ['fechamento precedido de espaço', '*texto *'],
    ['string vazia', ''],
  ])('%s', (_label, text) => {
    const nodes = parseWhatsApp(text).flatMap((line) => line.children);
    expect(spans(nodes, 'bold')).toEqual([]);
    expect(plainText(nodes)).toBe(text);
  });

  it('atravessa quebra de linha', () => {
    const lines = parseWhatsApp('*linha um\nlinha dois*');
    expect(lines.flatMap((line) => spans(line.children, 'bold'))).toEqual([]);
    expect(lines.map((line) => plainText(line.children))).toEqual(['*linha um', 'linha dois*']);
  });
});

describe('itálico e tachado (D-242)', () => {
  it('_x_ e ~x~ formatam, dentro e fora da mesma frase', () => {
    expect(spans(inline('_ok_'), 'italic')).toEqual(['ok']);
    expect(spans(inline('~velho~'), 'strike')).toEqual(['velho']);
    const nodes = inline('Coleta _amanhã_, valor ~R$ 90~ *R$ 80*');
    expect(spans(nodes, 'italic')).toEqual(['amanhã']);
    expect(spans(nodes, 'strike')).toEqual(['R$ 90']);
    expect(spans(nodes, 'bold')).toEqual(['R$ 80']);
    expect(plainText(nodes)).toBe('Coleta amanhã, valor R$ 90 R$ 80');
  });

  it('símbolos diferentes aninham (`_*x*_`, `*_x_*`, `~*x*~`)', () => {
    expect(inline('_*importante*_')).toEqual([
      {
        type: 'italic',
        children: [{ type: 'bold', children: [{ type: 'text', text: 'importante' }] }],
      },
    ]);
    expect(spans(inline('*_x_*'), 'italic')).toEqual(['x']);
    expect(spans(inline('*_x_*'), 'bold')).toEqual(['x']);
    const both = inline('_*importante*_ e ~*antigo*~');
    expect(spans(both, 'bold')).toEqual(['importante', 'antigo']);
    expect(spans(both, 'strike')).toEqual(['antigo']);
  });

  it('`*` com `_` sobrepostos: vence quem abriu primeiro, o outro fica como texto', () => {
    const nodes = inline('_a *b_ c*');
    expect(spans(nodes, 'italic')).toEqual(['a *b']);
    expect(spans(nodes, 'bold')).toEqual([]);
    expect(plainText(nodes)).toBe('a *b c*');
  });

  it.each([
    ['snake_case', 'use snake_case_var aqui'],
    ['sublinhado solto', 'nota _ importante'],
    ['__ vazio', 'isso __ aquilo'],
    ['til colado', 'a~b~c'],
    ['til solto', '~ 30 min'],
    ['fechamento com espaço antes', '_texto _'],
  ])('não formata: %s', (_label, text) => {
    const nodes = inline(text);
    expect(nodes).toEqual([{ type: 'text', text }]);
  });
});

describe('mono e código (literais)', () => {
  it('```mono``` e `código` viram literal, sem formatar por dentro', () => {
    expect(inline('rode ```npm *run* _x_``` agora')).toEqual([
      { type: 'text', text: 'rode ' },
      { type: 'mono', text: 'npm *run* _x_' },
      { type: 'text', text: ' agora' },
    ]);
    expect(inline('o campo `nome_do_paciente` é *obrigatório*')).toEqual([
      { type: 'text', text: 'o campo ' },
      { type: 'code', text: 'nome_do_paciente' },
      { type: 'text', text: ' é ' },
      { type: 'bold', children: [{ type: 'text', text: 'obrigatório' }] },
    ]);
  });

  it('mono seguido de `código` não engole a crase do vizinho', () => {
    expect(inline('```d``` `e`')).toEqual([
      { type: 'mono', text: 'd' },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'e' },
    ]);
  });

  it('mono atravessa linhas e não abre linha nova', () => {
    const lines = parseWhatsApp('antes\n```linha 1\nlinha 2```\ndepois');
    expect(lines).toHaveLength(3);
    expect(lines[1]?.children).toEqual([{ type: 'mono', text: 'linha 1\nlinha 2' }]);
  });

  it('crases soltas ficam como texto', () => {
    expect(inline('``` sozinho')).toEqual([{ type: 'text', text: '``` sozinho' }]);
    expect(inline('um ` só')).toEqual([{ type: 'text', text: 'um ` só' }]);
  });

  it('mono dentro de negrito', () => {
    expect(inline('*veja ```x```*')).toEqual([
      {
        type: 'bold',
        children: [
          { type: 'text', text: 'veja ' },
          { type: 'mono', text: 'x' },
        ],
      },
    ]);
  });
});

describe('links (D-242)', () => {
  const links = (text: string) =>
    parseWhatsApp(text)
      .flatMap((line) => line.children)
      .flatMap(function collect(node): WhatsAppNode[] {
        if (node.type === 'link') return [node];
        return 'children' in node ? node.children.flatMap(collect) : [];
      });

  it('http, https e www viram link; www ganha https://', () => {
    expect(links('acesse https://lab.com.br/resultado hoje')).toEqual([
      { type: 'link', href: 'https://lab.com.br/resultado', text: 'https://lab.com.br/resultado' },
    ]);
    expect(links('http://a.com')).toEqual([{ type: 'link', href: 'http://a.com', text: 'http://a.com' }]);
    expect(links('www.lab.com.br')).toEqual([
      { type: 'link', href: 'https://www.lab.com.br', text: 'www.lab.com.br' },
    ]);
  });

  it('URL com `_` ou `~` dentro não vira itálico/tachado', () => {
    const text = 'veja https://site.com/a_b_c/~user/x_y agora';
    expect(links(text)).toEqual([
      {
        type: 'link',
        href: 'https://site.com/a_b_c/~user/x_y',
        text: 'https://site.com/a_b_c/~user/x_y',
      },
    ]);
    expect(spans(inline(text), 'italic')).toEqual([]);
    expect(spans(inline(text), 'strike')).toEqual([]);
  });

  it('pontuação do fim da frase e parêntese sem par ficam fora do link', () => {
    expect(links('veja www.lab.com.')[0]).toMatchObject({ text: 'www.lab.com' });
    expect(links('(link: https://x.com/a)')[0]).toMatchObject({ text: 'https://x.com/a' });
    expect(links('https://pt.wikipedia.org/wiki/A_(b)')[0]).toMatchObject({
      text: 'https://pt.wikipedia.org/wiki/A_(b)',
    });
  });

  it('link dentro de ênfase', () => {
    const nodes = inline('*https://lab.com*');
    expect(nodes[0]).toMatchObject({ type: 'bold' });
    expect(links('_https://lab.com/a_b_')).toEqual([
      { type: 'link', href: 'https://lab.com/a_b', text: 'https://lab.com/a_b' },
    ]);
  });

  it('não é link: javascript:, texto colado, www sozinho, e-mail, link dentro de código', () => {
    expect(links('javascript:alert(1)')).toEqual([]);
    expect(links('xhttps://a.com')).toEqual([]);
    expect(links('www. nada')).toEqual([]);
    expect(links('fulano@www.lab.com')).toEqual([]);
    expect(links('`https://a.com`')).toEqual([]);
  });
});

describe('linhas: citação e listas', () => {
  it('`> `, `- `, `* ` e `1. ` no começo da linha', () => {
    const lines = parseWhatsApp('> citado\n- um\n* dois\n12. doze\nnormal');
    expect(lines.map((line) => [line.kind, line.marker, plainText(line.children)])).toEqual([
      ['quote', undefined, 'citado'],
      ['bullet', undefined, 'um'],
      ['bullet', undefined, 'dois'],
      ['numbered', '12', 'doze'],
      ['plain', undefined, 'normal'],
    ]);
  });

  it('o conteúdo da linha formata normal; sem espaço depois não é prefixo', () => {
    const [quote] = parseWhatsApp('> *importante*');
    expect(quote && spans(quote.children, 'bold')).toEqual(['importante']);
    expect(parseWhatsApp('-5 graus')[0]?.kind).toBe('plain');
    expect(parseWhatsApp('*negrito* no começo')[0]?.kind).toBe('plain');
    expect(parseWhatsApp('>sem espaço')[0]?.kind).toBe('plain');
    expect(parseWhatsApp('meio > não')[0]?.kind).toBe('plain');
  });
});

describe('HTML é texto', () => {
  it('`<script>` e tags viram nós de texto, nunca marcação', () => {
    const text = '<script>alert("x")</script> <b>oi</b> <img src=x onerror=alert(1)>';
    expect(inline(text)).toEqual([{ type: 'text', text }]);
  });

  it('link não engole `<`/`>`', () => {
    const text = 'https://a.com/<script>';
    expect(inline(text)[0]).toEqual({ type: 'link', href: 'https://a.com/', text: 'https://a.com/' });
  });
});
