// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/*
 * Architectural boundaries (see docs/architecture.md), enforced by lint:
 *  - no shell/process spawning anywhere in the agent;
 *  - mineflayer may only be imported by the adapter in src/bot/mineflayer-client.ts;
 *  - only the ActionExecutor may mint ValidatedAction tokens.
 */
const noShell = [
  { name: 'child_process', message: 'The agent must not run shell commands.' },
  { name: 'node:child_process', message: 'The agent must not run shell commands.' },
];
const noMineflayer = {
  name: 'mineflayer',
  message: 'Only src/bot/mineflayer-client.ts may import mineflayer.',
};
const noMinting = {
  group: ['**/validated-action.ts'],
  importNames: ['mintValidatedAction'],
  message: 'Only the ActionExecutor may mint ValidatedAction tokens.',
};

/** @param {{ mineflayer: boolean, minting: boolean }} allow */
const boundaries = (allow) => [
  'error',
  {
    paths: [...noShell, ...(allow.mineflayer ? [] : [noMineflayer])],
    patterns: allow.minting ? [] : [noMinting],
  },
];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'data/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-imports': boundaries({ mineflayer: false, minting: false }),
    },
  },
  {
    files: ['src/bot/mineflayer-client.ts'],
    rules: { 'no-restricted-imports': boundaries({ mineflayer: true, minting: false }) },
  },
  {
    files: ['src/executor/action-executor.ts', 'tests/**/*.ts'],
    rules: { 'no-restricted-imports': boundaries({ mineflayer: false, minting: true }) },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
