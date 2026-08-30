/**
 * Seed de convênios (Onda 7 — Apêndice A do spec, D-081/D-082).
 *
 * Fonte: docs/superpowers/specs/2026-08-30-onda-7-design.md, Apêndice A —
 * dados ANS (competência mar/2026). `ansCode` fica `undefined` quando a
 * pesquisa não confirmou o registro; NUNCA inventado.
 *
 * NÃO inclui:
 *   - "Particular": não é uma linha de `insurances` (D-082) — é a AUSÊNCIA de
 *     convênio (`insurance_id NULL` em `proposals`).
 *   - Agemed: operadora em liquidação extrajudicial pela ANS desde out/2020.
 *
 * Cada Unimed é convênio próprio (sistema de ~340 cooperativas independentes,
 * cada uma com registro ANS individual) — por isso "Unimed Tubarão" e "Unimed
 * Grande Florianópolis" são duas linhas distintas, não uma genérica "Unimed".
 *
 * `SC Saúde` entra com `type: 'especial'`: plano estadual de servidores de SC,
 * fora da regulação ANS — por isso não tem `ansCode`, e não é erro.
 */
import type { CreateInsuranceRequest } from '@crm-lab/shared';

export const INSURANCE_SEED: readonly CreateInsuranceRequest[] = [
  // ---------------------------------------------------------------- Nacionais
  {
    name: 'Hapvida',
    officialName: 'Hapvida Assistência Médica Ltda.',
    type: 'medicina_grupo',
    ansCode: '368253',
  },
  {
    name: 'NotreDame Intermédica',
    officialName: 'Notre Dame Intermédica Saúde S.A.',
    type: 'medicina_grupo',
    ansCode: '359017',
  },
  {
    name: 'Bradesco Saúde',
    officialName: 'Bradesco Saúde S.A.',
    type: 'seguradora',
    ansCode: '005711',
  },
  {
    name: 'Amil',
    officialName: 'Amil Assistência Médica Internacional S.A.',
    type: 'medicina_grupo',
    ansCode: '326305',
  },
  {
    name: 'SulAmérica',
    officialName: 'Sul América Companhia de Seguro Saúde',
    type: 'seguradora',
    ansCode: '006246',
  },
  {
    name: 'Seguros Unimed',
    officialName: 'Unimed Seguros Saúde S.A.',
    type: 'seguradora',
  },
  {
    name: 'Porto Seguro Saúde',
    officialName: 'Porto Seguro – Seguro Saúde S.A.',
    type: 'seguradora',
  },
  {
    name: 'Cassi',
    officialName: 'Caixa de Assistência dos Funcionários do Banco do Brasil',
    type: 'autogestao',
  },
  {
    name: 'Prevent Senior',
    officialName: 'Prevent Senior Private Operadora de Saúde Ltda.',
    type: 'medicina_grupo',
  },
  {
    name: 'Assim Saúde',
    officialName: 'Assim Saúde',
    type: 'medicina_grupo',
  },
  {
    name: 'GEAP',
    officialName: 'GEAP Autogestão em Saúde',
    type: 'autogestao',
  },
  {
    name: 'Saúde Caixa',
    officialName: 'Plano dos empregados da Caixa Econômica Federal',
    type: 'autogestao',
  },
  {
    name: 'Postal Saúde',
    officialName: 'Caixa de Assistência dos Empregados dos Correios',
    type: 'autogestao',
  },
  {
    name: 'Saúde Petrobras',
    officialName: 'Associação Petrobras de Saúde – APS',
    type: 'autogestao',
  },
  {
    name: 'Care Plus',
    officialName: 'Care Plus Medicina Assistencial Ltda.',
    type: 'medicina_grupo',
    ansCode: '379956',
  },
  {
    name: 'Omint',
    officialName: 'Omint Serviços de Saúde Ltda.',
    type: 'medicina_grupo',
    ansCode: '359661',
  },

  // ------------------------------------------------------------ Regionais SC
  {
    name: 'Unimed Tubarão',
    officialName: 'Unimed de Tubarão Cooperativa de Trabalho Médico',
    type: 'cooperativa',
    ansCode: '364860',
  },
  {
    name: 'Unimed Grande Florianópolis',
    officialName: 'Unimed Grande Florianópolis Coop. de Trabalho Médico',
    type: 'cooperativa',
  },
  {
    // Plano estadual de servidores de SC, fora da regulação ANS — por isso
    // não tem `ansCode` (não é lacuna de pesquisa, é ausência de registro).
    name: 'SC Saúde',
    officialName: 'Sistema de Assistência à Saúde dos Servidores de SC',
    type: 'especial',
  },
  {
    name: 'Celos Saúde',
    officialName: 'Fundação Celesc de Seguridade Social',
    type: 'autogestao',
    ansCode: '315044',
  },
];
