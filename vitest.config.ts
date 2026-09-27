import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests must never reach the network or a real Minecraft server.
    restoreMocks: true,
  },
});
