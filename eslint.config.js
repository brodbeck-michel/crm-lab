import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.config.js',
      '**/*.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // Regra 6 do CLAUDE.md: `any` proibido — use `unknown` + narrowing.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    // Regra 10 do CLAUDE.md: sem console.log no backend — usar o logger estruturado.
    files: ['backend/src/**/*.ts'],
    ignores: ['backend/src/db/cli/**'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    // A regra 6 do CLAUDE.md ("`any` proibido") NAO abre excecao para teste, e
    // ate a Onda 6 este bloco desligava `no-explicit-any` justamente aqui — a
    // fronteira em que um `as any` esconde divergencia de shape em vez de
    // revelar (foi assim que `UserModal.spec.tsx` escondeu um defeito, a
    // pendencia D1). Com os specs de backend e de frontend ja tipados, o
    // desligamento nao suprimia mais nada: removido, o lint continua com o
    // mesmo numero de erros. `no-console` fica desligado de proposito — a
    // regra 10 e sobre o backend em producao, nao sobre depurar um teste.
    files: ['**/*.spec.ts', '**/*.spec.tsx', '**/tests/**/*.ts', '**/e2e/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
);
