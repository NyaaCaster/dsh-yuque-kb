import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    // CSS Modules resolve to class maps in jsdom (client packages ship CSS).
    css: true,
    server: {
      deps: {
        // The primitives client package ships built ESM importing CSS
        // Modules; inline it so vitest's pipeline (not Node) resolves them.
        inline: ['@deepseek-ai/dsh-client-ui-primitives'],
      },
    },
  },
})