import { useState, type FormEvent, type KeyboardEvent, type Ref } from 'react'
import { MAX_PIN } from '../../../shared/vault'
import { SecretField } from '../ui/Field'

/** Main's own wording (pin.ts), shown as soon as the field holds more digits than any PIN can. */
export const PIN_FORMAT_ERROR = 'PIN must be 6-12 digits'
/** Room for a pasted overlong PIN, so it gets the format message rather than being cut to fit. */
const MAX_PIN_INPUT = 64

/**
 * A masked, numeric PIN input that drops anything but digits. The PIN stays in the input; callers
 * read it through `ref`, or get it from `onComplete`, which also empties the field. `onComplete`
 * fires once `length` digits are in, or on Enter when the length isn't known (unlock). Without
 * `onComplete`, Enter submits the enclosing form as usual.
 */
export function PinField({
  label = 'PIN',
  length,
  onComplete,
  onDigits,
  disabled = false,
  error,
  hint,
  autoFocus,
  ref,
}: {
  label?: string
  length?: number
  onComplete?: (pin: string) => void
  /** How many digits the field holds after each edit; never the digits themselves. */
  onDigits?: (count: number) => void
  disabled?: boolean
  error?: string
  hint?: string
  autoFocus?: boolean
  ref?: Ref<HTMLInputElement>
}) {
  const [tooLong, setTooLong] = useState(false)

  const complete = (input: HTMLInputElement) => {
    const pin = input.value
    if (!onComplete || disabled || !pin || pin.length > MAX_PIN) return
    input.value = ''
    setTooLong(false)
    onDigits?.(0)
    onComplete(pin)
  }

  const onInput = (e: FormEvent<HTMLInputElement>) => {
    const input = e.currentTarget
    const digits = input.value.replace(/\D/g, '')
    if (digits !== input.value) input.value = digits
    setTooLong(digits.length > MAX_PIN)
    onDigits?.(digits.length)
    if (length !== undefined && digits.length === length) complete(input)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || !onComplete) return
    e.preventDefault()
    complete(e.currentTarget)
  }

  return (
    <SecretField
      ref={ref}
      label={label}
      inputMode="numeric"
      autoFocus={autoFocus}
      // readOnly, not disabled: the field keeps focus while an attempt is in flight.
      readOnly={disabled}
      maxLength={MAX_PIN_INPUT}
      onInput={onInput}
      onKeyDown={onKeyDown}
      error={tooLong ? PIN_FORMAT_ERROR : error}
      hint={hint}
    />
  )
}
