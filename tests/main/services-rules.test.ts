import { describe, expect, it } from 'vitest'
import { COMPOSE_PROJECT, COMPOSE_SERVICE } from '../../src/shared/deploy'
import { DB_DEFAULT_PORT, MAX_SERVICES, deriveTag, listNames, pickAppHost, stripSecretRefs } from '../../src/shared/services'

describe('services rules', () => {
  it('COMPOSE_SERVICE is the compose project pattern', () => {
    expect(COMPOSE_SERVICE).toBe(COMPOSE_PROJECT)
    for (const ok of ['esg', 'js_foundry', 'fastapi-app', 'redis.1']) expect(COMPOSE_SERVICE.test(ok)).toBe(true)
    for (const bad of ['--rm', '-p', 'a b', 'x;rm', '']) expect(COMPOSE_SERVICE.test(bad)).toBe(false)
    expect(MAX_SERVICES).toBe(512)
    expect(DB_DEFAULT_PORT).toEqual({ postgres: 5432, mysql: 3306, mongodb: 27017, redis: 6379, other: null })
  })

  it('listNames joins with commas and a final and', () => {
    expect(listNames([])).toBe('')
    expect(listNames(['a'])).toBe('a')
    expect(listNames(['a', 'b'])).toBe('a and b')
    expect(listNames(['a', 'b', 'c'])).toBe('a, b and c')
  })

  it('pickAppHost returns the app host with most checkouts, breaks ties by label, and returns null with no app host', () => {
    const hosts = [
      { hostId: 'h1', role: 'app' as const, label: 'web-b' },
      { hostId: 'h2', role: 'app' as const, label: 'web-a' },
      { hostId: 'h3', role: 'db' as const, label: 'db-1' },
    ]
    expect(pickAppHost(hosts, ['h1', 'h1', 'h2', 'h3', 'h3', 'h3'])).toBe('h1')
    expect(pickAppHost(hosts, ['h1', 'h2'])).toBe('h2')
    expect(pickAppHost(hosts, [])).toBe('h2')
    expect(pickAppHost([hosts[2]], ['h3'])).toBeNull()
    expect(pickAppHost([], [])).toBeNull()
  })

  it('deriveTag swaps a delimited environment name and refuses otherwise', () => {
    expect(deriveTag('webapp_staging', 'staging', 'Prod')).toBe('webapp_prod')
    expect(deriveTag('webapp', 'staging', 'prod')).toBeNull()
    expect(deriveTag('x_staging', 'staging', 'pre prod')).toBeNull()
    expect(deriveTag('STAGING-api.staging', 'staging', 'qa')).toBe('qa-api.qa')
    expect(deriveTag('webapp_stagingx', 'staging', 'prod')).toBeNull()
    expect(deriveTag('deploy_stxg', 'st.g', 'prod')).toBeNull()
    expect(deriveTag('staging', 'staging', 'prod')).toBe('prod')
  })

  it('deriveTag inserts the target name literally, so $& or $1 in a name is not a replace pattern', () => {
    // As a replace string, 'a$&b' would splice the match back in and give the valid ref 'webapp_astagingb'.
    expect(deriveTag('webapp_staging', 'staging', 'a$&b')).toBeNull()
    expect(deriveTag('webapp_staging', 'staging', 'q$1')).toBeNull()
    expect(deriveTag('webapp_$&', '$&', 'prod')).toBe('webapp_prod')
  })

  it('stripSecretRefs blanks every secret reference', () => {
    expect(stripSecretRefs('A=${secret:abc}\nB=1')).toBe('A=\nB=1')
    expect(stripSecretRefs('A=${secret:x}${secret:y}\n# ${secret:z}')).toBe('A=\n# ')
  })
})
