import { readFileSync } from 'node:fs'

import { defineConfig } from 'vite'

/**
 * Builds the command line tool: dist/fiverunner.js, which has the Lua
 * sources of the engine in it, with cfxlua.wasm next to it.
 */
export default defineConfig({
  build: {
    ssr: 'src/cli/bin.ts',
    outDir: 'dist',
    target: 'node22',
    rolldownOptions: {
      output: { entryFileNames: 'fiverunner.js', banner: '#!/usr/bin/env node' },
    },
  },
  plugins: [
    {
      name: 'cfxlua',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'cfxlua.wasm',
          source: readFileSync(new URL('src/core/lua/cfxlua.wasm', import.meta.url)),
        })
      },
    },
  ],
})
