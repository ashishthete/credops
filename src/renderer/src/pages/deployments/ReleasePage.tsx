import { ArrowLeft } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { useNavigate, useParams } from 'react-router'
import { releaseStore } from '../../deploy/releases'
import { Button } from '../../ui/Button'
import { ReleaseView } from './release/ReleaseView'

/** One release on its own page, from the history, the palette or a map chip. */
export function ReleasePage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const envId = useSyncExternalStore(releaseStore.subscribe, () => releaseStore.get().byId[id]?.environmentId)
  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex h-16 shrink-0 items-end gap-3 px-8 pb-3">
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowLeft aria-hidden className="size-3.5" />}
          onClick={() => navigate(envId ? `/deployments?env=${envId}&tab=history` : '/deployments')}
        >
          History
        </Button>
        <h1 className="text-[19px] font-semibold tracking-tight text-fg">Release</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 pb-10">
        <ReleaseView key={id} releaseId={id} />
      </div>
    </div>
  )
}
