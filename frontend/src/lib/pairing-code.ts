import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, normalizePairingCode } from '@crm-lab/shared';

/**
 * Código de pareamento do dispositivo de captura (CRMLAB-184, D-326) como a
 * tela mostra: `K7MX-4QPR`. Serve para o que a pessoa digita na `/digitalizar`
 * (maiúsculas, só o alfabeto do código, no máximo 8 símbolos) e para o código
 * que o servidor devolve em Canais & Equipe. O hífen é só visual.
 */
export function formatPairingCode(input: string): string {
  const clean = Array.from(normalizePairingCode(input))
    .filter((char) => PAIRING_CODE_ALPHABET.includes(char))
    .slice(0, PAIRING_CODE_LENGTH)
    .join('');
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}
