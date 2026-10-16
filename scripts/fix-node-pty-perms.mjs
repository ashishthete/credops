// node-pty 1.1 ships spawn-helper without the execute bit when installed by pnpm; every spawn then fails.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

try {
  const root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
  const prebuilds = join(root, 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) {
      const helper = join(prebuilds, dir, 'spawn-helper')
      if (existsSync(helper)) chmodSync(helper, 0o755)
    }
  }
} catch {
  // node-pty isn't installed (yet): nothing to fix.
}
