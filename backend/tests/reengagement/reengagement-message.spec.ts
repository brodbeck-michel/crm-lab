/**
 * Variavel `{paciente}` no reingajamento (CRMLAB-96, D-266) — funcoes puras de
 * `shared/types/reengagement.types.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  findUnknownReengagementVariables,
  firstNameOf,
  hasReengagementTextBesidesVariables,
  renderReengagementMessage,
} from '@crm-lab/shared';

describe('firstNameOf', () => {
  it.each([
    ['MARIA DA SILVA', 'Maria'],
    ['joão pedro', 'João'],
    ['  ana-luísa souza', 'Ana-Luísa'],
    ['~ Érica 🌸', 'Érica'],
    ['ÍTALO', 'Ítalo'],
  ])('%s -> %s', (input, expected) => {
    expect(firstNameOf(input)).toBe(expected);
  });

  it.each([null, undefined, '', '   ', '🌸 ✨', '123'])('sem letra -> null (%s)', (input) => {
    expect(firstNameOf(input)).toBeNull();
  });
});

describe('renderReengagementMessage', () => {
  it('troca {paciente} pelo nome, em todas as ocorrencias', () => {
    expect(renderReengagementMessage('Olá, {paciente}! Tudo bem, {paciente}?', 'Maria')).toBe(
      'Olá, Maria! Tudo bem, Maria?',
    );
  });

  it.each([
    ['Olá {paciente}! 😊', 'Olá! 😊'],
    ['Olá, {paciente}.', 'Olá.'],
    ['Olá, {paciente}, tudo bem?', 'Olá, tudo bem?'],
    ['Oi {paciente} tudo certo?', 'Oi tudo certo?'],
    ['{paciente}, seguimos à disposição.', 'seguimos à disposição.'],
    ['Bom dia!\n{paciente}, ficou alguma dúvida?', 'Bom dia!\nficou alguma dúvida?'],
  ])('sem nome: %j -> %j', (message, expected) => {
    expect(renderReengagementMessage(message, null)).toBe(expected);
    expect(renderReengagementMessage(message, '')).toBe(expected);
  });

  it('mensagem sem variavel sai igual, com ou sem nome', () => {
    const fixed = 'Olá! Passando para saber se ficou alguma dúvida.';
    expect(renderReengagementMessage(fixed, 'Maria')).toBe(fixed);
    expect(renderReengagementMessage(fixed, null)).toBe(fixed);
  });

  it('variavel desconhecida fica como esta', () => {
    expect(renderReengagementMessage('Oi {cliente}', 'Maria')).toBe('Oi {cliente}');
  });
});

describe('validacao da mensagem', () => {
  it('so {paciente} e conhecida', () => {
    expect(findUnknownReengagementVariables('Olá {paciente}')).toEqual([]);
    expect(findUnknownReengagementVariables('Olá {nome} {valor} {nome} {}')).toEqual(['nome', 'valor', '']);
  });

  it('mensagem so com a variavel nao tem texto', () => {
    expect(hasReengagementTextBesidesVariables(' {paciente} ')).toBe(false);
    expect(hasReengagementTextBesidesVariables('{paciente}, {paciente}')).toBe(false);
    expect(hasReengagementTextBesidesVariables('Oi {paciente}')).toBe(true);
  });
});
