import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    splitting: false,
    outDir: 'dist',
    target: 'node20',
    esbuildOptions(options) {
      options.conditions = ['import']
    },
  },
  {
    entry: { 'cli/index': 'src/cli/index.ts' },
    format: ['esm'],
    dts: true,
    clean: false,
    sourcemap: true,
    splitting: false,
    outDir: 'dist',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    esbuildOptions(options) {
      options.conditions = ['import']
    },
  },
])
