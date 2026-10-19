import { KeyRound } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { MAX_ENV_TEMPLATE, parseEnvTemplate } from '../../../../shared/deploy'
import type { SecretMeta, VaultMeta } from '../../../../shared/vault'
import { envKeyFor } from '../../deploy/form'
import { SelectField, TextAreaField } from '../../ui/Field'

interface EnvTemplateEditorProps {
  value: string
  onChange: (next: string) => void
  /** Every secret the renderer knows, to name the references. Only metadata: values are never fetched. */
  secrets: SecretMeta[]
  /** The secrets the deployment may use (those in its vaults); the insert picker lists these. */
  available: SecretMeta[]
  vaults: VaultMeta[]
  error?: string
}

/** A monospace .env editor. `${secret:<id>}` references show below as chips carrying the secret's name. */
export function EnvTemplateEditor({ value, onChange, secrets, available, vaults, error }: EnvTemplateEditorProps) {
  const area = useRef<HTMLTextAreaElement>(null)
  const byId = useMemo(() => new Map(secrets.map((s) => [s.id, s])), [secrets])
  const vaultColor = useMemo(() => new Map(vaults.map((v) => [v.id, v.color])), [vaults])
  const refs = useMemo(
    () =>
      parseEnvTemplate(value).lines.flatMap((l) => ('key' in l && l.value.kind === 'secret' ? [{ key: l.key, secretId: l.value.secretId }] : [])),
    [value],
  )

  const insert = (secretId: string) => {
    const secret = byId.get(secretId)
    if (!secret) return
    const el = area.current
    const at = el ? el.selectionStart : value.length
    const end = el ? el.selectionEnd : value.length
    const lineStart = value.lastIndexOf('\n', at - 1) + 1
    // On a line with no KEY= yet, write the whole assignment.
    const text = value.slice(lineStart, at).includes('=') ? `\${secret:${secretId}}` : `${envKeyFor(secret.name)}=\${secret:${secretId}}`
    onChange(value.slice(0, at) + text + value.slice(end))
    const caret = at + text.length
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }

  return (
    <div className="flex flex-col gap-2.5">
      <TextAreaField
        ref={area}
        label="Environment file"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={8}
        maxLength={MAX_ENV_TEMPLATE}
        spellCheck={false}
        autoComplete="off"
        placeholder={'APP_ENV=production\nDB_PASSWORD=${secret:…}'}
        error={error}
        hint={error ? undefined : 'KEY=value lines. Put anything sensitive in a vault secret and reference it.'}
        className="min-h-40 font-mono text-[12.5px]"
      />
      <SelectField
        label="Insert secret"
        value=""
        onChange={(e) => {
          if (e.target.value) insert(e.target.value)
        }}
        disabled={available.length === 0}
        hint={available.length === 0 ? 'Pick a vault below to use its secrets.' : undefined}
      >
        <option value="">Choose a secret…</option>
        {available.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </SelectField>
      {refs.length > 0 && (
        <ul aria-label="Secret references" className="flex flex-wrap gap-1.5">
          {refs.map((r) => {
            const secret = byId.get(r.secretId)
            return (
              <li
                key={r.key}
                className={`inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[12px] ${
                  secret ? 'border-line bg-white/[0.04] text-fg' : 'border-warn/40 bg-warn/10 text-warn'
                }`}
              >
                <span className="font-mono text-muted">{r.key}</span>
                {secret ? (
                  <>
                    <span aria-hidden className="size-1.5 rounded-full" style={{ background: vaultColor.get(secret.vaultId) ?? 'var(--muted)' }} />
                    <KeyRound aria-hidden className="size-3 text-muted" />
                    <span data-testid="secret-chip">{secret.name}</span>
                  </>
                ) : (
                  <span data-testid="secret-chip">Missing secret</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
