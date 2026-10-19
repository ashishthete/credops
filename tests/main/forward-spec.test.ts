import { describe, expect, it } from 'vitest'
import { parseForwardSpec } from '../../src/main/inventory/forward-spec'
import { MAX_LABEL } from '../../src/shared/vault'

const input = (type: 'L' | 'R' | 'D', spec: string, alias = 'web') => {
  const r = parseForwardSpec({ type, spec }, alias)
  if ('error' in r) throw new Error(r.error)
  return r.input
}
const error = (type: 'L' | 'R' | 'D', spec: string) => {
  const r = parseForwardSpec({ type, spec }, 'web')
  return 'error' in r ? r.error : null
}

describe('parseForwardSpec', () => {
  it('parses L with and without bind', () => {
    expect(input('L', '5433 localhost:5432', 'db-1')).toEqual({
      label: 'db-1 L 5433',
      type: 'L',
      bindAddress: '127.0.0.1',
      bindPort: 5433,
      targetHost: 'localhost',
      targetPort: 5432,
      autoStart: false,
      autoReconnect: true,
    })
    expect(input('L', '0.0.0.0:5433 db:5432').bindAddress).toBe('0.0.0.0')
  })

  it('parses bracketed IPv6 and star', () => {
    expect(input('L', '[::1]:8080 [fe80::1]:80')).toMatchObject({ bindAddress: '::1', bindPort: 8080, targetHost: 'fe80::1', targetPort: 80 })
    expect(input('D', '*:1080').bindAddress).toBe('0.0.0.0')
  })

  it('parses D', () => {
    expect(input('D', '1080')).toMatchObject({ type: 'D', bindPort: 1080, label: 'web SOCKS 1080' })
    expect(input('D', '1080').targetHost).toBeUndefined()
  })

  it('rejects unix sockets, reverse dynamic and garbage with the exact errors', () => {
    expect(error('L', '/tmp/s localhost:1')).toBe("unix socket forwards aren't supported")
    expect(error('R', '9000 /var/run/x.sock')).toBe("unix socket forwards aren't supported")
    expect(error('R', '9000')).toBe("reverse dynamic forwards aren't supported")
    for (const [t, s] of [['L', 'nonsense'], ['L', '5433'], ['L', 'x localhost:1'], ['L', '1 localhost'], ['L', '1 h:0'], ['L', '99999 h:1'], ['D', '1080 extra'], ['D', 'a:b:1']] as const) {
      expect(error(t, s)).toBe("can't read this forward")
    }
  })

  it('never puts the target host in the label', () => {
    expect(input('L', '1 secret.internal:2').label).not.toContain('secret')
  })

  it('labels are capped at MAX_LABEL', () => {
    expect(input('L', '1 h:2', 'a'.repeat(500)).label).toHaveLength(MAX_LABEL)
  })
})
