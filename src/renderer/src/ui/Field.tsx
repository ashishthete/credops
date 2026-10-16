import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, Eye, EyeOff } from 'lucide-react'
import { useId, useState, type ComponentProps, type ReactNode } from 'react'
import { fast, useMotionSafe } from './motion'

interface FieldChrome {
  label: string
  error?: string
  /** Muted helper text, replaced by the error while there is one. */
  hint?: ReactNode
}

const control =
  'w-full rounded-lg border border-line bg-canvas/60 text-[13px] text-fg placeholder:text-muted/60 transition-[border-color,box-shadow] hover:border-muted/30 focus:border-accent/60 focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_18%,transparent)] focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-55 aria-invalid:border-err/60 aria-invalid:focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--err)_18%,transparent)]'

function useFieldIds(id?: string) {
  const auto = useId()
  const base = id ?? auto
  return { id: base, msgId: `${base}-msg` }
}

function Shell({
  id,
  msgId,
  label,
  error,
  hint,
  children,
}: FieldChrome & { id: string; msgId: string; children: ReactNode }) {
  const motionSafe = useMotionSafe()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[12.5px] font-medium text-fg/90">
        {label}
      </label>
      {children}
      <AnimatePresence initial={false} mode="popLayout">
        {(error || hint) && (
          // Keyed by text, so a hint that turns into the same error just changes colour.
          <motion.p
            key={typeof (error || hint) === 'string' ? (error || (hint as string)) : 'hint'}
            id={msgId}
            aria-live="polite"
            initial={motionSafe ? { opacity: 0, y: -2 } : { opacity: 0 }}
            animate={motionSafe ? { opacity: 1, y: 0 } : { opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fast}
            className={`text-[12px] leading-4 transition-colors ${error ? 'text-err' : 'text-muted'}`}
          >
            {error || hint}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  )
}

const described = (msgId: string, f: FieldChrome) => (f.error || f.hint ? msgId : undefined)

export function TextField({ label, error, hint, id, className = '', ...rest }: FieldChrome & ComponentProps<'input'>) {
  const ids = useFieldIds(id)
  return (
    <Shell {...ids} label={label} error={error} hint={hint}>
      <input
        id={ids.id}
        aria-invalid={error ? true : undefined}
        aria-describedby={described(ids.msgId, { label, error, hint })}
        className={`h-9 px-3 ${control} ${className}`}
        {...rest}
      />
    </Shell>
  )
}

/** A password input with a show/hide toggle; never autocompleted or spell-checked. */
export function SecretField({
  label,
  error,
  hint,
  id,
  className = '',
  ...rest
}: FieldChrome & Omit<ComponentProps<'input'>, 'type'>) {
  const ids = useFieldIds(id)
  const [visible, setVisible] = useState(false)
  const Icon = visible ? EyeOff : Eye
  return (
    <Shell {...ids} label={label} error={error} hint={hint}>
      <div className="relative">
        <input
          id={ids.id}
          type={visible ? 'text' : 'password'}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={described(ids.msgId, { label, error, hint })}
          className={`h-9 pr-9 pl-3 font-mono tracking-wide ${control} ${className}`}
          {...rest}
        />
        <button
          type="button"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          // Keep the caret in the input while toggling.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setVisible((v) => !v)}
          className="absolute top-1/2 right-1 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted transition-colors hover:bg-white/6 hover:text-fg"
        >
          <Icon aria-hidden className="size-3.5" />
        </button>
      </div>
    </Shell>
  )
}

export function SelectField({
  label,
  error,
  hint,
  id,
  className = '',
  children,
  ...rest
}: FieldChrome & ComponentProps<'select'>) {
  const ids = useFieldIds(id)
  return (
    <Shell {...ids} label={label} error={error} hint={hint}>
      <div className="relative">
        <select
          id={ids.id}
          aria-invalid={error ? true : undefined}
          aria-describedby={described(ids.msgId, { label, error, hint })}
          className={`h-9 appearance-none pr-8 pl-3 ${control} ${className}`}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted" />
      </div>
    </Shell>
  )
}

export function TextAreaField({
  label,
  error,
  hint,
  id,
  className = '',
  ...rest
}: FieldChrome & ComponentProps<'textarea'>) {
  const ids = useFieldIds(id)
  return (
    <Shell {...ids} label={label} error={error} hint={hint}>
      <textarea
        id={ids.id}
        aria-invalid={error ? true : undefined}
        aria-describedby={described(ids.msgId, { label, error, hint })}
        className={`min-h-20 px-3 py-2 leading-5 ${control} ${className}`}
        {...rest}
      />
    </Shell>
  )
}
