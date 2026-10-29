import { describe, expect, it } from 'vitest'
import { runnableSshCommand } from '../../src/renderer/src/tunnels/form'
import type { ResolvedHop, ResolvedHost } from '../../src/shared/inventory'
import { tunnelMeta } from './helpers'

const host = (over: Partial<ResolvedHost> = {}): ResolvedHost => ({
  hostId: 'h1',
  environmentId: 'prod',
  address: '198.51.100.99',
  addressSource: 'host',
  port: { value: 22, source: 'global' },
  identity: { source: 'host', identityId: 'i1', label: 'ubuntu (ssh-agent)', username: 'ubuntu', auth: 'agent', vaultId: 'v1' },
  jump: { hostId: null, source: null },
  chain: [],
  conflicts: [],
  ...over,
})
const hop = (address: string, port: number, username: string): ResolvedHop => ({
  hostId: address,
  label: address,
  address,
  addressSource: 'host',
  port,
  identity: { source: 'global', username, auth: 'default' },
})

describe('runnableSshCommand', () => {
  it('logs in as the resolved user at the resolved address, forwarding only', () => {
    expect(runnableSshCommand(tunnelMeta({ id: 't', bindPort: 5475 }), host())).toBe('ssh -N -L 5475:localhost:5432 ubuntu@198.51.100.99')
  })

  it('adds the port, the jump chain and a non-default bind', () => {
    const cmd = runnableSshCommand(
      tunnelMeta({ id: 't', bindAddress: '0.0.0.0', bindPort: 8080, targetHost: '10.0.0.9', targetPort: 80 }),
      host({ port: { value: 2222, source: 'host' }, chain: [hop('bastion.example.com', 22, 'ops'), hop('fd00::1', 2200, 'ops')] }),
    )
    expect(cmd).toBe("ssh -N -L 0.0.0.0:8080:10.0.0.9:80 -p 2222 -J ops@bastion.example.com,'ops@[fd00::1]:2200' ubuntu@198.51.100.99")
  })

  it('writes a SOCKS tunnel as -D with just its port', () => {
    expect(runnableSshCommand(tunnelMeta({ id: 't', type: 'D', bindPort: 1080, targetHost: null, targetPort: null }), host())).toBe('ssh -N -D 1080 ubuntu@198.51.100.99')
  })
})
