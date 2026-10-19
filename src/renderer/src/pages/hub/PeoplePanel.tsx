import { UserPlus, Users } from 'lucide-react'
import { DEFAULT_GROUP_ID, type HubRole, type HubUser } from '../../../../shared/hub'
import { addMembers, setUserDisabled, setUserRole, useHub } from '../../hub/store'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import type { Tone } from '../../ui/tone'
import { ListSkeleton } from './HubPage'
import { useHubGroupNames } from './names'

const STATUS: Record<HubUser['status'], { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'success' },
  pending: { label: 'Pending', tone: 'warn' },
  disabled: { label: 'Disabled', tone: 'error' },
}

export function PeoplePanel() {
  const { users, adminLoaded, status } = useHub()
  const groupName = useHubGroupNames()
  const me = status.linked ? status.user?.oid : undefined
  const pending = users.filter((u) => u.status === 'pending')

  if (!adminLoaded) return <ListSkeleton />
  if (users.length === 0) {
    return <EmptyState icon={Users} title="No one has signed in yet" text="People appear here the first time they sign in to the Hub." />
  }
  return (
    <div className="flex flex-col gap-4">
      {pending.length > 0 && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface/70 px-4 py-3">
          <p className="text-[13px] text-muted">
            {pending.length === 1 ? '1 person is' : `${pending.length} people are`} signed in but not in any group.
          </p>
          <Button
            size="sm"
            icon={<UserPlus aria-hidden className="size-3.5" />}
            onClick={() =>
              void addMembers(
                DEFAULT_GROUP_ID,
                pending.map((u) => u.oid),
              )
            }
          >
            {`Add all pending to Default (${pending.length})`}
          </Button>
        </div>
      )}
      <table className="w-full text-left text-[13px]">
        <thead className="text-[11.5px] text-muted">
          <tr>
            <th className="py-2 pr-3 font-medium">Name</th>
            <th className="py-2 pr-3 font-medium">UPN</th>
            <th className="py-2 pr-3 font-medium">Role</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">Groups</th>
            <th className="py-2 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.oid} className="border-t border-line">
              <td className="py-2 pr-3 font-medium text-fg">{u.name}</td>
              <td className="py-2 pr-3 text-muted">{u.upn}</td>
              <td className="py-2 pr-3">
                <select
                  aria-label={`Role for ${u.name}`}
                  value={u.role}
                  onChange={(e) => void setUserRole(u.oid, e.target.value as HubRole)}
                  className="h-7 rounded-md border border-line bg-surface-2/60 px-2 text-[12.5px] text-fg"
                >
                  <option value="admin">Admin</option>
                  <option value="maintainer">Maintainer</option>
                </select>
              </td>
              <td className="py-2 pr-3">
                <Badge tone={STATUS[u.status].tone}>{STATUS[u.status].label}</Badge>
              </td>
              <td className="py-2 pr-3">
                <span className="flex flex-wrap gap-1">
                  {u.groupIds.length === 0 ? <span className="text-muted">None</span> : u.groupIds.map((id) => <Badge key={id}>{groupName(id)}</Badge>)}
                </span>
              </td>
              <td className="py-2 text-right">
                {u.status === 'disabled' ? (
                  <Button size="sm" variant="ghost" aria-label={`Enable ${u.name}`} onClick={() => void setUserDisabled(u.oid, false)}>
                    Enable
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Disable ${u.name}`}
                    disabled={u.oid === me}
                    title={u.oid === me ? "You can't disable yourself" : undefined}
                    onClick={() => void setUserDisabled(u.oid, true)}
                  >
                    Disable
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
