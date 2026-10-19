import { builtinModules } from 'node:module'
import { chmodSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}
const external = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  ...Object.keys(pkg.dependencies ?? {}),
]

export default defineConfig({
  root: here,
  build: {
    ssr: resolve(here, 'src/cli.ts'),
    outDir: resolve(here, 'dist'),
    target: 'node24',
    rollupOptions: { external, output: { entryFileNames: 'opsdeck-hub.mjs', format: 'es', banner: '#!/usr/bin/env node' } },
  },
  plugins: [
    {
      name: 'executable-bin',
      apply: 'build',
      writeBundle(opts) {
        if (opts.dir) chmodSync(resolve(opts.dir, 'opsdeck-hub.mjs'), 0o755)
      },
    },
  ],
})
