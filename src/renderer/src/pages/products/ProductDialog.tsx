import { AnimatePresence, motion } from 'framer-motion'
import { Boxes, Building2, Database, Globe, Layers, Leaf, Rocket, Sparkles, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { MAX_DESCRIPTION, MAX_NAME, PRODUCT_ICONS, type ProductIcon, type ProductMeta } from '../../../../shared/inventory'
import { inv } from '../../inventory/store'
import { Button } from '../../ui/Button'
import { ColorPicker, VAULT_COLORS } from '../../ui/common'
import { Dialog } from '../../ui/Dialog'
import { TextAreaField, TextField } from '../../ui/Field'
import { fast, spring, useMotionSafe } from '../../ui/motion'
import { toast } from '../../ui/Toaster'

export const PRODUCT_ICON: Record<ProductIcon, LucideIcon> = {
  boxes: Boxes,
  leaf: Leaf,
  globe: Globe,
  database: Database,
  layers: Layers,
  rocket: Rocket,
  sparkles: Sparkles,
  building: Building2,
}

const ICON_NAME: Record<ProductIcon, string> = {
  boxes: 'Boxes',
  leaf: 'Leaf',
  globe: 'Globe',
  database: 'Database',
  layers: 'Layers',
  rocket: 'Rocket',
  sparkles: 'Sparkles',
  building: 'Building',
}

/** The product's icon on a tile of its color. */
export function ProductTile({ icon, color, size = 'md' }: { icon: ProductIcon; color: string; size?: 'md' | 'lg' }) {
  const Icon = PRODUCT_ICON[icon]
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center ${size === 'lg' ? 'size-9 rounded-[10px]' : 'size-7 rounded-lg'}`}
      style={{
        color,
        background: `color-mix(in oklab, ${color} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 32%, transparent), 0 6px 18px -8px ${color}`,
      }}
    >
      <Icon className={size === 'lg' ? 'size-[18px]' : 'size-4'} strokeWidth={2} />
    </span>
  )
}

/** Create a product, or edit one. */
export function ProductDialog({
  open,
  product,
  onClose,
  onSaved,
}: {
  open: boolean
  product?: ProductMeta
  onClose: () => void
  onSaved: (product: ProductMeta, created: boolean) => void
}) {
  const motionSafe = useMotionSafe()
  const formId = useId()
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(VAULT_COLORS[0].hex)
  const [icon, setIcon] = useState<ProductIcon>('boxes')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(product?.name ?? '')
    setColor(product?.color ?? VAULT_COLORS[0].hex)
    setIcon(product?.icon ?? 'boxes')
    setDescription(product?.description ?? '')
  }, [open, product])

  const valid = name.trim().length > 0
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    const saved = await inv.saveProduct({ name: name.trim(), color, icon, description: description.trim() }, product?.id)
    setBusy(false)
    if (saved) {
      toast({ title: product ? `Saved ${saved.name}` : `Created ${saved.name}`, tone: 'success' })
      onSaved(saved, !product)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={product ? 'Edit product' : 'New product'}
      description={product ? undefined : 'Something you ship. Its environments and hosts gather under it.'}
      width={440}
      icon={
        <div className="mb-3">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={`${icon}${color}`}
              className="inline-block"
              initial={motionSafe ? { scale: 0.5, rotate: -14, opacity: 0 } : { opacity: 0 }}
              animate={{ scale: 1, rotate: 0, opacity: 1 }}
              transition={motionSafe ? { ...spring, damping: 15 } : fast}
            >
              <ProductTile icon={icon} color={color} size="lg" />
            </motion.span>
          </AnimatePresence>
        </div>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!valid} loading={busy}>
            {product ? 'Save' : 'Create product'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void submit(e)} className="flex flex-col gap-3.5" noValidate>
        <TextField autoFocus label="Name" placeholder="Acme" maxLength={MAX_NAME} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-fg/90">Icon</span>
          <div role="radiogroup" aria-label="Icon" className="flex flex-wrap gap-1">
            {PRODUCT_ICONS.map((id) => {
              const Icon = PRODUCT_ICON[id]
              const checked = id === icon
              return (
                <motion.button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={ICON_NAME[id]}
                  title={ICON_NAME[id]}
                  onClick={() => setIcon(id)}
                  whileTap={motionSafe ? { scale: 0.86 } : undefined}
                  transition={spring}
                  className={`relative grid size-8 place-items-center rounded-lg transition-colors ${
                    checked ? '' : 'text-muted hover:bg-white/[0.05] hover:text-fg'
                  }`}
                  style={checked ? { color } : undefined}
                >
                  {checked && (
                    <motion.span
                      layoutId={motionSafe ? 'product-icon-ring' : undefined}
                      transition={spring}
                      className="absolute inset-0 rounded-lg"
                      style={{
                        background: `color-mix(in oklab, ${color} 14%, transparent)`,
                        boxShadow: `inset 0 0 0 1.5px color-mix(in oklab, ${color} 55%, transparent)`,
                      }}
                    />
                  )}
                  <Icon aria-hidden className="relative size-4" strokeWidth={2} />
                </motion.button>
              )
            })}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium text-fg/90">Color</span>
          <ColorPicker value={color} onChange={setColor} />
        </div>
        <TextAreaField
          label="Description"
          placeholder="Optional"
          rows={2}
          maxLength={MAX_DESCRIPTION}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </form>
    </Dialog>
  )
}
