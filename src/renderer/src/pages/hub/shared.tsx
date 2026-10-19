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
