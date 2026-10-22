import { SEGMENT_KINDS, TEMPLATE_SECRET_REF, type ConfigCounts, type ConfigEnvironment, type ConfigFile, type ConfigSegment, type ConfigStepBody } from '../../shared/config-file'

type Kind = keyof ConfigCounts

const KINDS: readonly Kind[] = ['regions', 'products', 'identities', 'hosts', 'environments', 'tunnels', 'deployments', 'services', 'runbooks']

export interface SegmentSelection {
  /** A valid config file: the page's own objects and what they refer to, and the secret refs those use. */
  file: ConfigFile
  /** The page's own kinds. Every other kind left in `file` is there as a dependency. */
  own: ReadonlySet<Kind>
  /** The ids kept, by kind. */
  kept: Record<Kind, ReadonlySet<string>>
  /** Objects left out: neither the page's kinds nor needed by one. */
  ignored: number
}

/**
 * The part of `file` a page imports or exports: every object of the page's kinds, then, transitively, every object
 * they refer to. A dependency environment goes without its release flow, which would pull in its services, and keeps
 * only its links to hosts kept for another reason: the ones its tunnels and checkouts use.
 */
export function selectSegment(file: ConfigFile, segment: ConfigSegment): SegmentSelection {
  const own = new Set<Kind>(SEGMENT_KINDS[segment])
  const index = <T extends { id: string }>(xs: T[]): Map<string, T> => new Map(xs.map((x) => [x.id, x]))
  const ix = {
    regions: index(file.regions),
    products: index(file.products),
    identities: index(file.identities),
    hosts: index(file.hosts),
    environments: index(file.environments),
    tunnels: index(file.tunnels),
    deployments: index(file.deployments),
    services: index(file.services),
    runbooks: index(file.runbooks ?? []),
  }
  const kept = Object.fromEntries(KINDS.map((k) => [k, new Set<string>()])) as Record<Kind, Set<string>>
  const queue: [Kind, string][] = []
  const need = (kind: Kind, id: string | null): void => {
    if (id === null || kept[kind].has(id) || !ix[kind].has(id)) return
    kept[kind].add(id)
    queue.push([kind, id])
  }
  for (const kind of own) for (const id of ix[kind].keys()) need(kind, id)

  while (queue.length > 0) {
    const [kind, id] = queue.pop()!
    switch (kind) {
      case 'hosts': {
        const h = ix.hosts.get(id)!
        need('regions', h.regionId)
        need('identities', h.identityId)
        need('hosts', h.jumpHostId)
        break
      }
      case 'environments': {
        const e = ix.environments.get(id)!
        need('products', e.productId)
        // A version 1 file's import names the product links it dropped.
        for (const p of file.fromV1?.productIds[id] ?? []) need('products', p)
        need('identities', e.defaultIdentityId)
        need('hosts', e.defaultJumpHostId)
        if (own.has('environments')) for (const m of e.hosts) need('hosts', m.hostId)
        if (own.has('environments')) for (const st of e.flow?.stages ?? []) for (const s of st.kind === 'services' ? st.serviceIds : [st.serviceId]) need('services', s)
        break
      }
      case 'tunnels': {
        const t = ix.tunnels.get(id)!
        need('hosts', t.hostId)
        need('environments', t.environmentId)
        break
      }
      case 'deployments': {
        const d = ix.deployments.get(id)!
        need('environments', d.environmentId)
        need('hosts', d.hostId)
        break
      }
      case 'services': {
        const s = ix.services.get(id)!
        need('environments', s.environmentId)
        if (s.kind === 'service') need('deployments', s.deploymentId)
        else {
          need('hosts', s.viaHostId)
          need('tunnels', s.tunnelId)
        }
        break
      }
      case 'runbooks': {
        const r = ix.runbooks.get(id)!
        need('environments', r.environmentId)
        for (const s of r.targetServiceIds) need('services', s)
        break
      }
    }
  }

  const pick = <T extends { id: string }>(kind: Kind, xs: T[]): T[] => xs.filter((x) => kept[kind].has(x.id))
  const environments = pick('environments', file.environments).map((e): ConfigEnvironment => {
    if (own.has('environments')) return e
    const { flow: _, ...rest } = e
    return { ...rest, hosts: e.hosts.filter((m) => kept.hosts.has(m.hostId)) }
  })
  const deployments = pick('deployments', file.deployments)
  const runbooks = pick('runbooks', file.runbooks ?? [])

  // The secret refs the kept objects use, and no others.
  const used = new Set<string>()
  const useSteps = (steps: ConfigStepBody[]): void => {
    for (const st of steps) for (const sec of st.secrets) used.add(sec.secret)
  }
  for (const d of deployments) {
    if (d.becomeSecret !== null) used.add(d.becomeSecret)
    for (const m of (d.envTemplate ?? '').matchAll(TEMPLATE_SECRET_REF)) used.add(m[1])
    useSteps(d.steps ?? [])
  }
  for (const e of environments) useSteps((e.flow?.stages ?? []).flatMap((st) => (st.kind === 'step' ? [st.step] : [])))
  for (const r of runbooks) useSteps(r.items.flatMap((it) => (it.type === 'step' ? [it.step] : [])))
  const secretRefs = Object.fromEntries(Object.entries(file.secretRefs).filter(([key]) => used.has(key)))

  const out: ConfigFile = {
    format: file.format,
    version: file.version,
    exportedAt: file.exportedAt,
    secretRefs,
    regions: pick('regions', file.regions),
    products: pick('products', file.products),
    identities: pick('identities', file.identities),
    hosts: pick('hosts', file.hosts),
    environments,
    tunnels: pick('tunnels', file.tunnels),
    deployments,
    services: pick('services', file.services),
    ...(runbooks.length === 0 ? {} : { runbooks }),
    ...(file.fromV1 ? { fromV1: { productIds: Object.fromEntries(Object.entries(file.fromV1.productIds).filter(([e]) => kept.environments.has(e))) } } : {}),
  }
  const total = KINDS.reduce((n, k) => n + ix[k].size, 0)
  const keptTotal = KINDS.reduce((n, k) => n + kept[k].size, 0)
  return { file: out, own, kept, ignored: total - keptTotal }
}
