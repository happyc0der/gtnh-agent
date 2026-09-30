// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/*
 * Architectural boundaries (see docs/architecture.md), enforced by lint:
 *  - no shell/process spawning anywhere in the agent;
 *  - mineflayer may only be imported by the adapter in src/bot/mineflayer-client.ts;
 *  - only the ActionExecutor may mint ValidatedAction tokens;
 *  - only the Minecraft adapters in src/bot/ may open network sockets.
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

const socketMessage = 'Only the Minecraft adapters in src/bot/ may open network sockets.';
const noSockets = [
  ...['net', 'node:net'].map((name) => ({
    name,
    importNames: ['connect', 'createConnection', 'Socket', 'createServer', 'Server'],
    message: socketMessage,
  })),
  ...['tls', 'node:tls', 'dgram', 'node:dgram', 'http', 'node:http', 'https', 'node:https'].map(
    (name) => ({ name, message: socketMessage }),
  ),
];

/** @param {{ mineflayer?: boolean, minting?: boolean, sockets?: boolean }} allow */
const boundaries = (allow) => [
  'error',
  {
    paths: [
      ...noShell,
      ...(allow.mineflayer ? [] : [noMineflayer]),
      ...(allow.sockets ? [] : noSockets),
    ],
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
      'no-restricted-imports': boundaries({}),
    },
  },
  {
    files: ['src/bot/**/*.ts'],
    rules: { 'no-restricted-imports': boundaries({ sockets: true }) },
  },
  {
    files: ['src/bot/mineflayer-client.ts'],
    rules: { 'no-restricted-imports': boundaries({ mineflayer: true, sockets: true }) },
  },
  {
    files: ['src/executor/action-executor.ts'],
    rules: { 'no-restricted-imports': boundaries({ minting: true }) },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { 'no-restricted-imports': boundaries({ minting: true, sockets: true }) },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
