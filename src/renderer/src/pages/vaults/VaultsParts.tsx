import { AnimatePresence, motion } from 'framer-motion'
import { FileUp, FolderOpen, KeyRound, LockKeyhole, Plus, ShieldX, UserRound, Wand2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { exitFast, fast, useMotionSafe } from '../../ui/motion'
import { Skeleton } from '../../ui/Skeleton'

// The page's static pieces: tabs, per-tab toolbars, empty and loading states.

export const TABS = [
  { id: 'secrets', label: 'Secrets', noun: 'secrets' },
  { id: 'keys', label: 'SSH keys', noun: 'SSH keys' },
  { id: 'identities', label: 'Identities', noun: 'identities' },
] as const
export type Tab = (typeof TABS)[number]['id']

export type NewDialog = 'secret' | 'generate' | 'import' | 'link' | 'identity'

export function Toolbar({ tab, onNew }: { tab: Tab; onNew: (which: NewDialog) => void }) {
  const motionSafe = useMotionSafe()
  const sets: Record<Tab, { label: string; actions: { which: NewDialog; label: string; icon: ReactNode; primary?: boolean }[] }> = {
    secrets: {
      label: 'Secret actions',
      actions: [{ which: 'secret', label: 'New secret', icon: <Plus aria-hidden className="size-3.5" />, primary: true }],
    },
    keys: {
      label: 'SSH key actions',
      actions: [
        { which: 'link', label: 'Link from ~/.ssh', icon: <FolderOpen aria-hidden className="size-3.5" /> },
        { which: 'import', label: 'Import key', icon: <FileUp aria-hidden className="size-3.5" /> },
        { which: 'generate', label: 'Generate key', icon: <Wand2 aria-hidden className="size-3.5" />, primary: true },
      ],
    },
    identities: {
      label: 'Identity actions',
      actions: [{ which: 'identity', label: 'New identity', icon: <Plus aria-hidden className="size-3.5" />, primary: true }],
    },
  }
  const set = sets[tab]
  return (
    // The old tab's buttons pop out of the flow at once, so the new ones never wait for them.
    <AnimatePresence initial={false} mode="popLayout">
      <motion.div
        key={tab}
        role="toolbar"
        aria-label={set.label}
        initial={motionSafe ? { opacity: 0, y: 3 } : { opacity: 0 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, transition: exitFast }}
        transition={fast}
        className="flex items-center gap-1.5 pb-1.5"
      >
        {set.actions.map((a) => (
          <Button key={a.which} size="sm" variant={a.primary ? 'primary' : 'ghost'} icon={a.icon} onClick={() => onNew(a.which)}>
            {a.label}
          </Button>
        ))}
      </motion.div>
    </AnimatePresence>
  )
}

export function Empty({ tab, onNew }: { tab: Tab; onNew: (which: NewDialog) => void }) {
  if (tab === 'secrets')
    return (
      <EmptyState
        icon={LockKeyhole}
        title="No secrets yet"
        text="Passwords, tokens and env values, encrypted with this vault's key."
        action={{ label: 'New secret', run: () => onNew('secret') }}
      />
    )
  if (tab === 'keys')
    return (
      <EmptyState
        icon={KeyRound}
        title="No SSH keys yet"
        text="Generate a fresh key, import one, or link a key file from ~/.ssh."
        action={{ label: 'Generate key', run: () => onNew('generate') }}
      />
    )
  return (
    <EmptyState
      icon={UserRound}
      title="No identities yet"
      text="An identity pairs a username with an SSH key, the agent or a password."
      action={{ label: 'New identity', run: () => onNew('identity') }}
    />
  )
}

export function SkeletonRows() {
  return (
    <div aria-hidden className="overflow-hidden rounded-ui border border-line bg-surface/50">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex h-14 items-center gap-3 border-b border-line/60 px-4 last:border-0">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-6 w-24" />
        </div>
      ))}
    </div>
  )
}

export function CorruptVault() {
  return (
    <div className="flex flex-1 items-center justify-center px-8 pb-16">
      <div className="flex max-w-sm flex-col items-center text-center">
        <span className="mb-5 grid size-14 place-items-center rounded-2xl border border-err/30 bg-err/10 text-err">
          <ShieldX aria-hidden className="size-6" strokeWidth={1.8} />
        </span>
        <h3 className="text-[15px] font-semibold text-fg">This vault can't be opened</h3>
        <p className="mt-1.5 text-[13px] leading-5 text-muted">
          Its key didn't decrypt at the last unlock, so its secrets, keys and identities can't be read or changed. The
          other vaults are fine.
        </p>
      </div>
    </div>
  )
}
