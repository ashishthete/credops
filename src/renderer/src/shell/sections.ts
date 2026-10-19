export const SECTIONS = [
  { id: 'products', label: 'Products', path: '/products' },
  { id: 'hosts', label: 'Hosts', path: '/hosts' },
  { id: 'vaults', label: 'Vaults', path: '/vaults' },
  { id: 'tunnels', label: 'Tunnels', path: '/tunnels' },
  { id: 'map', label: 'Map', path: '/map' },
  { id: 'deployments', label: 'Deployments', path: '/deployments' },
  { id: 'audit', label: 'Audit', path: '/audit' },
] as const

export type Section = (typeof SECTIONS)[number]
export type SectionId = Section['id']

/** `mod+1` for the first section, `mod+7` for the last. */
export const sectionShortcut = (index: number) => `mod+${index + 1}`
