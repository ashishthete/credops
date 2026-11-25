import { Boxes, Upload } from 'lucide-react'
import { useInventory, type InventoryData } from '../../inventory/store'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { useKeptState } from '../../ui/kept'
import { useConfigTransfer } from '../settings/ConfigTransfer'
import { ProductsPage } from './ProductsPage'

/** Nothing set up yet: no product, environment, host or identity. Vaults and regions come with a new install. */
export const isBlank = (d: InventoryData): boolean =>
  d.products.length === 0 && d.environments.length === 0 && d.hosts.length === 0 && d.identities.length === 0

/**
 * The page the app opens on. With nothing set up it offers a config file first, or starting by hand; after either
 * it is the Products page. The import dialog lives here, not in the welcome, so it outlives the welcome it replaces.
 */
export function ProductsLanding() {
  const data = useInventory()
  // Kept, so coming back to the page doesn't ask again; a lock or a relaunch does.
  const [skipped, setSkipped] = useKeptState('welcome.skipped', false)
  const { openImport, opening, dialog } = useConfigTransfer()
  const welcome = data !== null && !skipped && isBlank(data)
  return (
    <>
      {welcome ? (
        <div className="grid h-full place-items-center overflow-y-auto">
          <EmptyState
            icon={Boxes}
            title="Welcome to CredOps"
            text="Nothing is set up yet. Bring in a config file exported from another CredOps, or start with your first product."
            actions={
              <>
                <Button icon={<Upload aria-hidden className="size-3.5" />} loading={opening} onClick={() => void openImport()}>
                  Import config…
                </Button>
                <Button variant="ghost" onClick={() => setSkipped(true)}>
                  Start from scratch
                </Button>
              </>
            }
          />
        </div>
      ) : (
        <ProductsPage />
      )}
      {dialog}
    </>
  )
}
