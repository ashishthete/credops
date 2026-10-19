import { builtinModules } from 'node:module'
import { readFileSync } from 'node:fs'
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

// Finished in 10b T9.
export default defineConfig({
  root: here,
  build: {
    ssr: resolve(here, 'src/main.ts'),
    outDir: resolve(here, 'dist'),
    target: 'node24',
    rollupOptions: { external, output: { entryFileNames: 'opsdeck-hub.mjs', format: 'es' } },
  },
})
