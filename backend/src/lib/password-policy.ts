/**
 * Política de senha para troca própria (CRMLAB-35, D-153).
 *
 * Sem `zxcvbn`: dependência pesada (dicionários embutidos) para o ganho de
 * cobrir um caso que uma lista curta de senhas óbvias já pega. Mínimo 10
 * caracteres (maior que o mínimo de 8 da criação de usuário por admin,
 * `user.service.ts` — telas diferentes, escopos diferentes).
 */

export const MIN_NEW_PASSWORD_LENGTH = 10;

/** ~20 senhas triviais mais comuns em vazamentos públicos, normalizadas em minúsculo. */
const TRIVIAL_PASSWORDS = new Set([
  '1234567890',
  '12345678910',
  'password123',
  'senha123456',
  'senha1234',
  'qwertyuiop',
  '0987654321',
  'abcdefghij',
  'aaaaaaaaaa',
  '1111111111',
  'iloveyou123',
  'letmein123',
  'welcome123',
  'admin12345',
  'senhasegura',
  'trocaresta',
  'mudaresta1',
  '1a2b3c4d5e',
  'qazwsxedc1',
  'zxcvbnm123',
]);

export interface PasswordPolicyResult {
  ok: boolean;
  reason?: string;
}

export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < MIN_NEW_PASSWORD_LENGTH) {
    return { ok: false, reason: `Senha deve ter ao menos ${MIN_NEW_PASSWORD_LENGTH} caracteres` };
  }
  if (TRIVIAL_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, reason: 'Senha muito comum, escolha outra' };
  }
  return { ok: true };
}
