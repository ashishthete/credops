import type { EnvironmentMeta } from '../../../../shared/inventory'
import type { TunnelMeta } from '../../../../shared/tunnels'
import { deleteTunnel } from '../../tunnels/store'
import type { ConfirmRequest } from '../../ui/common'
import { toast } from '../../ui/Toaster'

/**
 * The delete confirmation for a tunnel. A running tunnel is stopped first; in a protected environment
 * the user types the environment's name.
 */
export function tunnelDeleteRequest(meta: TunnelMeta, environment: EnvironmentMeta | undefined, running: boolean): ConfirmRequest {
  const guarded = environment?.protected ? environment.name : undefined
  return {
    title: `Delete ${meta.label}?`,
    description: [
      running ? 'It will be stopped first.' : '',
      'The tunnel is removed from this machine.',
      guarded ? `It belongs to the protected ${guarded} environment.` : '',
    ]
      .filter(Boolean)
      .join(' '),
    confirmLabel: 'Delete tunnel',
    typeToConfirm: guarded,
    run: async () => {
      if (await deleteTunnel(meta.id)) toast({ title: `Deleted ${meta.label}`, tone: 'success' })
    },
  }
}
