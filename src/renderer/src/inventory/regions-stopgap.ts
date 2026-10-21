import type { EnvironmentMeta } from '../../../shared/inventory'

// regions-ui: an environment now has exactly one product, but the pages still read a list of them. Each caller
// carries a regions-ui note; the Regions UI (spec §7) replaces them and this file.

export const productIdsOf = (e: Pick<EnvironmentMeta, 'productId'>): string[] => [e.productId]
