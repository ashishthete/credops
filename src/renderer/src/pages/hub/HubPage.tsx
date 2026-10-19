import { motion } from 'framer-motion'
import { Network } from 'lucide-react'
import { useEffect, useState } from 'react'
import { isHubAdmin, startHubSync, useHub } from '../../hub/store'
import { Badge } from '../../ui/Badge'
import { fast, useMotionSafe } from '../../ui/motion'
import { Skeleton } from '../../ui/Skeleton'
import { PaneHeader } from '../products/ProductView'
import { ConnectCard } from './ConnectCard'
import { GroupsPanel } from './GroupsPanel'
import { HubAuditPanel } from './HubAuditPanel'
import { PeoplePanel } from './PeoplePanel'

const ALL_TABS = [
  { id: 'overview', label: 'Overview', admin: false },
  { id: 'people', label: 'People', admin: true },
  { id: 'groups', label: 'Groups', admin: true },
  { id: 'audit', label: 'Audit', admin: true },
] as const
type TabId = (typeof ALL_TABS)[number]['id']

/** The Hub section: connection and sign-in for everyone, People, Groups and Audit for admins. */
export function HubPage() {
  const motionSafe = useMotionSafe()
  const hub = useHub()
  const [tab, setTab] = useState<TabId>('overview')
  useEffect(() => startHubSync(), [])

  const admin = isHubAdmin(hub.status)
  const tabs = ALL_TABS.filter((t) => !t.admin || admin)
  const current = tabs.some((t) => t.id === tab) ? tab : 'overview'

  return (
    <div className="flex h-full flex-col">
      <PaneHeader
        lead={<Network aria-hidden className="size-5 text-accent" />}
        title="Hub"
        badges={
          hub.status.linked ? (
            <Badge tone={hub.status.online ? 'success' : 'warn'} dot>
              {hub.status.online ? 'Online' : 'Offline'}
            </Badge>
          ) : undefined
        }
      />
      {(
        <div role="tablist" aria-label="Hub sections" className="flex gap-1 border-b border-line px-8">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === current}
              onClick={() => setTab(t.id)}
              className={`-mb-px flex h-9 items-center border-b-2 px-3 text-[13px] font-medium transition-colors ${
                t.id === current ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <motion.div
        key={current}
        role="tabpanel"
        className="min-h-0 flex-1 overflow-y-auto px-8 pt-5 pb-8"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={fast}
        data-motion={motionSafe ? 'full' : 'reduced'}
      >
        {!hub.statusLoaded ? (
          <div aria-label="Loading the Hub" className="flex max-w-xl flex-col gap-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-32" />
          </div>
        ) : current === 'people' ? (
          <PeoplePanel />
        ) : current === 'groups' ? (
          <GroupsPanel />
        ) : current === 'audit' ? (
          <HubAuditPanel />
        ) : (
          <ConnectCard />
        )}
      </motion.div>
    </div>
  )
}

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
