import { ShieldQuestion } from 'lucide-react'
import { useRef } from 'react'
import type { SessionPrompt } from '../../../../shared/ssh'
import { answerPrompt } from '../../terminal/sessions'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'

type HostKeyPrompt = Extract<SessionPrompt, { kind: 'host-key' }>

/** `SHA256:abcdefgh…` as `SHA256: abcd efgh …`, so it can be read aloud and compared. */
export function groupFingerprint(fingerprint: string): string {
  const m = /^([A-Za-z0-9]+:)?(.*)$/.exec(fingerprint)
  const groups = (m?.[2] ?? fingerprint).match(/.{1,4}/g) ?? []
  return [m?.[1], ...groups].filter(Boolean).join(' ')
}

/** An unknown host key. A changed or revoked key never gets here: main refuses it outright. */
export function HostKeyDialog({ prompt, open }: { prompt: HostKeyPrompt; open: boolean }) {
  const answered = useRef(false)
  const { info } = prompt
  const answer = (trust: boolean) => {
    if (answered.current) return
    answered.current = true
    void answerPrompt(prompt.promptId, { kind: 'host-key', trust })
  }
  return (
    <Dialog
      open={open}
      onClose={() => answer(false)}
      title={`First time connecting to ${prompt.hopLabel}`}
      description="Check this fingerprint with the host's owner before you trust it."
      icon={<ShieldQuestion aria-hidden className="mb-2 size-5 text-warn" />}
      footer={
        <>
          {/* Focus starts on Cancel, so a stray Enter never trusts a key. */}
          <Button variant="ghost" data-autofocus onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button onClick={() => answer(true)}>Trust and connect</Button>
        </>
      }
    >
      <dl className="flex flex-col gap-2 text-[12.5px]">
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted">Key type</dt>
          <dd className="font-mono text-fg">{info.keyType}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted">Fingerprint</dt>
          <dd data-testid="fingerprint" className="font-mono leading-5 break-all text-fg">
            {groupFingerprint(info.fingerprint)}
          </dd>
        </div>
      </dl>
      {info.known.length > 0 && (
        <p className="mt-3 text-[12.5px] leading-5 text-muted">
          This host is known with a different key type ({[...new Set(info.known.map((k) => k.keyType))].join(', ')})
        </p>
      )}
    </Dialog>
  )
}
