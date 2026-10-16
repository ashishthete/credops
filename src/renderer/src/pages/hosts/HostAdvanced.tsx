import { AnimatePresence, motion } from 'framer-motion'
import { ChevronRight, Plus, X } from 'lucide-react'
import { useId, useState } from 'react'
import {
  ENV_NAME,
  MAX_ENV_VALUE,
  MAX_ENV_VARS,
  MAX_KEEPALIVE_SEC,
  UNSAFE_SSH_CHAR,
  type HostMeta,
} from '../../../../shared/inventory'
import { DEFAULT_KEEPALIVE_SEC } from '../../../../shared/ssh'
import { SelectField, TextField } from '../../ui/Field'
import { fast, spring, useMotionSafe } from '../../ui/motion'

export type KeepaliveMode = 'inherit' | 'off' | 'custom'
export interface EnvRow {
  key: number
  name: string
  value: string
}
export interface AdvancedState {
  keepalive: KeepaliveMode
  seconds: string
  rows: EnvRow[]
}

let nextRowKey = 0
export const blankRow = (): EnvRow => ({ key: nextRowKey++, name: '', value: '' })

export function advancedFrom(host?: HostMeta): AdvancedState {
  const sec = host?.keepaliveSec ?? null
  return {
    keepalive: sec === null ? 'inherit' : sec === 0 ? 'off' : 'custom',
    seconds: sec ? String(sec) : '',
    rows: Object.entries(host?.envVars ?? {}).map(([name, value]) => ({ key: nextRowKey++, name, value })),
  }
}

export interface AdvancedCheck {
  keepaliveSec: number | null
  envVars: Record<string, string>
  keepaliveError?: string
  /** Per row, in order; messages name the rule, never the variable or its value. */
  rowErrors: { name?: string; value?: string }[]
  listError?: string
  valid: boolean
}

const isBlank = (r: EnvRow) => !r.name.trim() && !r.value

/** Same rules, and the same wording, as the main-side validators in main/inventory/rows.ts. */
export function checkAdvanced(adv: AdvancedState): AdvancedCheck {
  let keepaliveSec: number | null = null
  let keepaliveError: string | undefined
  if (adv.keepalive === 'off') keepaliveSec = 0
  else if (adv.keepalive === 'custom') {
    const t = adv.seconds.trim()
    const n = Number(t)
    if (/^\d+$/.test(t) && n >= 1 && n <= MAX_KEEPALIVE_SEC) keepaliveSec = n
    else keepaliveError = `keepalive must be 1-${MAX_KEEPALIVE_SEC} seconds`
  }

  const used = adv.rows.filter((r) => !isBlank(r))
  const seen = new Set<string>()
  const envVars: Record<string, string> = {}
  const rowErrors = adv.rows.map((r): { name?: string; value?: string } => {
    if (isBlank(r)) return {}
    const out: { name?: string; value?: string } = {}
    const name = r.name.trim()
    if (!ENV_NAME.test(name)) out.name = 'an env var name is invalid'
    else if (seen.has(name)) out.name = 'an env var name is used more than once'
    else {
      seen.add(name)
      envVars[name] = r.value
    }
    if (r.value.length > MAX_ENV_VALUE) out.value = `an env var value must be a string of at most ${MAX_ENV_VALUE} characters`
    else if (UNSAFE_SSH_CHAR.test(r.value)) out.value = 'an env var value has control or format characters'
    return out
  })
  const listError = used.length > MAX_ENV_VARS ? `a host can have at most ${MAX_ENV_VARS} env vars` : undefined
  const sorted = Object.fromEntries(Object.entries(envVars).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return {
    keepaliveSec,
    envVars: sorted,
    keepaliveError,
    rowErrors,
    listError,
    valid: !keepaliveError && !listError && rowErrors.every((e) => !e.name && !e.value),
  }
}

interface HostAdvancedProps {
  value: AdvancedState
  check: AdvancedCheck
  onChange: (next: AdvancedState) => void
}

/** Keepalive and environment variables, folded away until asked for. */
export function HostAdvanced({ value, check, onChange }: HostAdvancedProps) {
  const motionSafe = useMotionSafe()
  const id = useId()
  const [open, setOpen] = useState(false)
  const setRow = (key: number, patch: Partial<EnvRow>) =>
    onChange({ ...value, rows: value.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) })
  const full = value.rows.length >= MAX_ENV_VARS

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-fit items-center gap-1.5 rounded-md pr-2 text-[12.5px] font-medium text-muted transition-colors hover:text-fg"
      >
        <motion.span animate={{ rotate: open && motionSafe ? 90 : 0 }} transition={spring} className="grid">
          <ChevronRight aria-hidden className={`size-3.5 ${open && !motionSafe ? 'rotate-90' : ''}`} />
        </motion.span>
        Advanced
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={`${id}-panel`}
            initial={motionSafe ? { opacity: 0, height: 0 } : { opacity: 0 }}
            animate={motionSafe ? { opacity: 1, height: 'auto' } : { opacity: 1 }}
            exit={{ opacity: 0, ...(motionSafe ? { height: 0 } : {}), transition: fast }}
            transition={motionSafe ? spring : fast}
            // Clipped only while it moves, so focus rings at the edges are never cut off.
            className="-mx-1 overflow-hidden px-1"
          >
            <div className="flex flex-col gap-3.5 pt-1 pb-1">
              <div className={`grid gap-3 ${value.keepalive === 'custom' ? 'grid-cols-[1fr_132px]' : ''}`}>
                <SelectField
                  label="Keepalive"
                  value={value.keepalive}
                  onChange={(e) => onChange({ ...value, keepalive: e.target.value as KeepaliveMode })}
                >
                  <option value="inherit">{`Inherit (${DEFAULT_KEEPALIVE_SEC} s)`}</option>
                  <option value="off">Off</option>
                  <option value="custom">Every N seconds</option>
                </SelectField>
                {value.keepalive === 'custom' && (
                  <TextField
                    label="Seconds"
                    inputMode="numeric"
                    value={value.seconds}
                    onChange={(e) => onChange({ ...value, seconds: e.target.value })}
                    error={check.keepaliveError}
                    className="font-mono tabular-nums"
                  />
                )}
              </div>

              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1.5 text-[12.5px] font-medium text-fg/90">Environment variables</legend>
                <AnimatePresence initial={false}>
                  {value.rows.map((r, i) => (
                    <motion.div
                      key={r.key}
                      layout={motionSafe ? 'position' : false}
                      initial={motionSafe ? { opacity: 0, y: -4 } : { opacity: 0 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, transition: fast }}
                      transition={motionSafe ? spring : fast}
                      className="flex flex-col gap-1"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          aria-label={`Variable name ${i + 1}`}
                          placeholder="NAME"
                          value={r.name}
                          onChange={(e) => setRow(r.key, { name: e.target.value })}
                          aria-invalid={check.rowErrors[i]?.name ? true : undefined}
                          spellCheck={false}
                          autoCapitalize="off"
                          autoComplete="off"
                          className="h-9 w-[38%] rounded-lg border border-line bg-canvas/60 px-3 font-mono text-[13px] text-fg transition-[border-color,box-shadow] placeholder:text-muted/60 hover:border-muted/30 focus:border-accent/60 focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_18%,transparent)] focus:outline-none aria-invalid:border-err/60"
                        />
                        <input
                          aria-label={`Variable value ${i + 1}`}
                          placeholder="value"
                          value={r.value}
                          onChange={(e) => setRow(r.key, { value: e.target.value })}
                          aria-invalid={check.rowErrors[i]?.value ? true : undefined}
                          spellCheck={false}
                          autoCapitalize="off"
                          autoComplete="off"
                          className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-canvas/60 px-3 font-mono text-[13px] text-fg transition-[border-color,box-shadow] placeholder:text-muted/60 hover:border-muted/30 focus:border-accent/60 focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_18%,transparent)] focus:outline-none aria-invalid:border-err/60"
                        />
                        <button
                          type="button"
                          aria-label={`Remove variable ${i + 1}`}
                          onClick={() => onChange({ ...value, rows: value.rows.filter((x) => x.key !== r.key) })}
                          className="grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-white/[0.08] hover:text-fg"
                        >
                          <X aria-hidden className="size-3.5" />
                        </button>
                      </div>
                      {(check.rowErrors[i]?.name || check.rowErrors[i]?.value) && (
                        <p role="alert" className="text-[12px] leading-4 text-err">
                          {check.rowErrors[i].name ?? check.rowErrors[i].value}
                        </p>
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>
                {check.listError && (
                  <p role="alert" className="text-[12px] leading-4 text-err">
                    {check.listError}
                  </p>
                )}
                <button
                  type="button"
                  disabled={full}
                  onClick={() => onChange({ ...value, rows: [...value.rows, blankRow()] })}
                  className="flex h-8 w-fit items-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 text-[12.5px] font-medium text-muted transition-colors hover:border-muted/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <Plus aria-hidden className="size-3.5" />
                  Add variable
                </button>
                <p className="text-[12px] leading-4 text-muted">Sent to the server at login. Don't put secrets here.</p>
              </fieldset>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
