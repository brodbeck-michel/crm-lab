/**
 * Sugestão do nono dígito (CRMLAB-121, D-287).
 *
 * Celular brasileiro tem 9 dígitos começando por 9. Quem cadastra às vezes
 * digita o número antigo, de 8 (o WhatsApp ainda mostra muitos assim). Os dois
 * formatos são aceitos e casam no servidor (D-176), mas a tela sugere o atual
 * para o cadastro ficar padronizado. Mesma faixa do servidor: só sugere quando
 * os 8 dígitos começam de 6 a 9 — de 2 a 5 é fixo, que não tem o 9.
 */

/** `(48) 99999-1234` a partir de um E.164 brasileiro; cru quando não é BR. */
export function formatBrazilianPhone(phone: string): string {
  const br = /^\+?55(\d{2})(\d{4,5})(\d{4})$/.exec(phone.replace(/[^\d+]/g, ''));
  return br ? `(${br[1]}) ${br[2]}-${br[3]}` : phone;
}

/**
 * O número com o 9 na frente, já formatado — ou `null` quando não há o que
 * sugerir (já tem o 9, é fixo, ou ainda não é um número completo).
 */
export function ninthDigitSuggestion(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  const national = digits.length === 12 && digits.startsWith('55') ? digits.slice(2) : digits;
  const match = /^([1-9]{2})([6-9]\d{3})(\d{4})$/.exec(national);
  if (!match) return null;
  return `(${match[1]}) 9${match[2]}-${match[3]}`;
}
