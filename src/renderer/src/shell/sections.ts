export const SECTIONS = [
  { id: 'products', label: 'Products', path: '/products' },
  { id: 'hosts', label: 'Hosts', path: '/hosts' },
  { id: 'vaults', label: 'Vaults', path: '/vaults' },
  { id: 'tunnels', label: 'Tunnels', path: '/tunnels' },
  { id: 'map', label: 'Map', path: '/map' },
  { id: 'ops', label: 'Ops', path: '/ops' },
  { id: 'deployments', label: 'Deployments', path: '/deployments' },
  { id: 'hub', label: 'Hub', path: '/hub' },
  { id: 'audit', label: 'Audit', path: '/audit' },
] as const

export type Section = (typeof SECTIONS)[number]
export type SectionId = Section['id']

/** `mod+1` for the first section up to `mod+9`; later sections have no digit shortcut (there is no `mod+10`). */
export const sectionShortcut = (index: number): string | null => (index < 9 ? `mod+${index + 1}` : null)
