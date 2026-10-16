import { KeyRound } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { PromptAnswer, SessionPrompt } from '../../../../shared/ssh'
import { answerPrompt } from '../../terminal/sessions'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { SecretField, TextField } from '../../ui/Field'

type AuthPrompt = Extract<SessionPrompt, { kind: 'password' | 'keyboard' }>

/**
 * A password or keyboard-interactive prompt. What is typed lives only in this component's state:
 * it is cleared when the answer goes out and when the dialog unmounts, and goes nowhere else.
 */
export function AuthPromptDialog({ prompt, open }: { prompt: AuthPrompt; open: boolean }) {
  const formId = useId()
  const count = prompt.kind === 'keyboard' ? prompt.prompts.length : 1
  const [values, setValues] = useState<string[]>(() => Array<string>(count).fill(''))
  // The answer waits in a ref (not state) for the render that blanks the fields; sent flips that render.
  const outgoing = useRef<PromptAnswer | null>(null)
  const [sent, setSent] = useState(false)

  useEffect(() => () => setValues([]), [])

  // The fields are blanked and re-rendered before the answer leaves: once main drops the prompt the
  // dialog animates out frozen as last rendered, and that must not be a frame holding the secret.
  useEffect(() => {
    if (!sent || !outgoing.current) return
    const answer = outgoing.current
    outgoing.current = null
    void answerPrompt(prompt.promptId, answer)
  }, [sent, prompt.promptId])

  const send = (submit: boolean) => {
    if (sent) return
    const typed = values
    setValues(Array<string>(count).fill(''))
    outgoing.current =
      prompt.kind === 'password'
        ? { kind: 'password', password: submit ? (typed[0] ?? '') : null }
        : { kind: 'keyboard', responses: submit ? Array.from({ length: count }, (_, i) => typed[i] ?? '') : null }
    setSent(true)
  }
  const set = (i: number, v: string) => setValues((vs) => vs.map((x, j) => (j === i ? v : x)))

  const title = prompt.kind === 'password' ? `Password for ${prompt.username}@${prompt.hopLabel}` : prompt.name || `Sign in to ${prompt.hopLabel}`
  return (
    <Dialog
      open={open}
      onClose={() => send(false)}
      title={title}
      description={prompt.kind === 'keyboard' ? prompt.instructions || undefined : undefined}
      icon={<KeyRound aria-hidden className="mb-2 size-5 text-accent" />}
      footer={
        <>
          <Button variant="ghost" onClick={() => send(false)}>
            Cancel
          </Button>
          <Button type="submit" form={formId}>
            Connect
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-3"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault()
          send(true)
        }}
      >
        {prompt.kind === 'password' ? (
          <SecretField label="Password" autoComplete="off" value={values[0] ?? ''} onChange={(e) => set(0, e.target.value)} />
        ) : (
          prompt.prompts.map((p, i) =>
            p.echo ? (
              <TextField key={i} label={p.prompt} autoComplete="off" spellCheck={false} value={values[i] ?? ''} onChange={(e) => set(i, e.target.value)} />
            ) : (
              <SecretField key={i} label={p.prompt} autoComplete="off" value={values[i] ?? ''} onChange={(e) => set(i, e.target.value)} />
            ),
          )
        )}
      </form>
    </Dialog>
  )
}
