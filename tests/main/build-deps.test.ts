import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

describe('build dependencies', () => {
  it('ssh2 and node-pty are runtime dependencies', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(pkg.dependencies.ssh2).toBeDefined()
    expect(pkg.dependencies['node-pty']).toBeDefined()
    expect(pkg.devDependencies['@xterm/xterm']).toBeDefined()
  })

  it('node-pty is unpacked from asar', () => {
    expect(read('electron-builder.yml')).toContain('node_modules/node-pty')
  })
})
