/**
 * Hash de senha (bcrypt).
 *
 * SECURITY.md exige cost 12 em producao. Em teste o custo cai para 4 — o hash
 * continua sendo bcrypt real (verificavel), so nao gasta ~300ms por factory.
 */
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

export const BCRYPT_COST = env.isTest ? 4 : 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
