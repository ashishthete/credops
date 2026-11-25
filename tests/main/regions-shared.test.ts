import { describe, expect, it } from 'vitest'
import {
  checkoutRegion,
  environmentRegions,
  hostRegion,
  hostRegions,
  regionHint,
  regionRefs,
  regionsOfHosts,
  serviceRegion,
} from '../../src/shared/regions'
import type { ServiceMeta } from '../../src/shared/services'

const regions = hostRegions([
  { id: 'h-eu', regionId: 'r-eu' },
  { id: 'h-eu2', regionId: 'r-eu' },
  { id: 'h-us', regionId: 'r-us' },
  { id: 'h-ap', regionId: 'r-ap' },
])
const checkouts = [
  { id: 'c1', environmentId: 'e1', hostId: 'h-eu' },
  { id: 'c2', environmentId: 'e1', hostId: 'h-us' },
  { id: 'c3', environmentId: 'e2', hostId: 'h-ap' },
]
const base = { name: 's', position: 0, description: '', createdAt: '', updatedAt: '' }
const app = (id: string, environmentId: string, hostId: string): ServiceMeta => ({
  ...base,
  id,
  environmentId,
  hostId,
  kind: 'service',
  deploymentId: null,
  composeService: 'web',
  url: null,
  urlCheckFrom: 'mac',
  lastDeployedCommit: null,
  lastReleaseId: null,
  skipUnchanged: false,
})
const db = (id: string, environmentId: string, hostId: string): ServiceMeta => ({
  ...base,
  id,
  environmentId,
  hostId,
  kind: 'db',
  dbEngine: 'postgres',
  dbAddress: 'localhost',
  dbPort: 5432,
  localPort: null,
  tunnelId: null,
})

describe('derived regions', () => {
  it("gives a host its region, and a checkout its host's", () => {
    expect(hostRegion(regions, 'h-us')).toBe('r-us')
    expect(hostRegion(regions, 'gone')).toBeNull()
    expect(hostRegion(regions, null)).toBeNull()
    expect(checkoutRegion(regions, { hostId: 'h-eu2' })).toBe('r-eu')
  })

  it("gives a service its host's region, else none", () => {
    expect(serviceRegion(regions, app('s1', 'e1', 'h-us'), checkouts)).toBe('r-us')
    expect(serviceRegion(regions, app('s3', 'e1', 'gone'), checkouts)).toBeNull()
    expect(serviceRegion(regions, db('s4', 'e1', 'h-ap'), checkouts)).toBe('r-ap')
  })

  it("gives an environment the distinct regions of its member hosts, checkout hosts and service hosts, and no one else's", () => {
    const env = { id: 'e1', hosts: [{ hostId: 'h-eu2', role: 'app' as const }, { hostId: 'h-eu', role: 'db' as const }] }
    expect(environmentRegions(regions, env, checkouts, [db('s1', 'e1', 'h-ap'), db('s2', 'e1', 'gone'), db('s3', 'e2', 'h-eu')])).toEqual([
      'r-eu',
      'r-us',
      'r-ap',
    ])
    expect(environmentRegions(regions, { id: 'e3', hosts: [] }, checkouts, [])).toEqual([])
  })

  it('collects the regions of a set of hosts and orders refs by code', () => {
    expect(regionsOfHosts(regions, ['h-us', 'h-eu', 'h-eu2', null])).toEqual(['r-us', 'r-eu'])
    const all = [
      { id: 'r-us', code: 'us-east-1', displayName: 'US', provider: 'aws' },
      { id: 'r-eu', code: 'eu-west-1', displayName: 'EU' },
    ]
    expect(regionRefs(['r-us', 'r-eu', 'gone'], all)).toEqual([
      { id: 'r-eu', code: 'eu-west-1', displayName: 'EU' },
      { id: 'r-us', code: 'us-east-1', displayName: 'US' },
    ])
  })
})

describe('regionHint', () => {
  it('is silent while the environment has no hosts', () => {
    expect(regionHint([], 'r-us')).toBeNull()
  })

  it('is silent when the host is in a region the environment already uses', () => {
    expect(regionHint(['r-eu', 'r-us'], 'r-us')).toBeNull()
  })

  it("names the environment's regions when the host brings a new one", () => {
    expect(regionHint(['r-eu'], 'r-us')).toEqual(['r-eu'])
  })
})
