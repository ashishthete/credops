import { UserCheck } from 'lucide-react'
import { EmptyState } from '../../ui/EmptyState'
import { Skeleton } from '../../ui/Skeleton'

/** Shared by the admin panels: skeleton rows while the first load runs. */
export function ListSkeleton() {
  return (
    <div aria-label="Loading" className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  )
}

export const roleLabel = (role: string) => (role === 'admin' ? 'Admin' : 'Maintainer')

/** What a signed-in person who is in no group yet sees in place of team environments. */
export function PendingNotice() {
  return (
    <EmptyState
      icon={UserCheck}
      title="Waiting for a Hub admin"
      text="You're signed in, but not in any group yet. A Hub admin needs to add you — until then you won't see any team deployments."
    />
  )
}
