import { MAX_PIN, MIN_PIN } from '../../shared/vault'
import { deriveKek, type KdfParams } from './crypto'

const PIN_FORMAT = new RegExp(`^\\d{${MIN_PIN},${MAX_PIN}}$`)

/** Digits only, MIN_PIN-MAX_PIN of them. The message never carries the PIN. */
export function checkPinFormat(pin: string): void {
  if (typeof pin !== 'string' || !PIN_FORMAT.test(pin)) throw new Error('PIN must be 6-12 digits')
}

/** For a new PIN: the format, then no repeated digit and no straight run up or down (no wrap 9 to 0). */
export function checkPin(pin: string): void {
  checkPinFormat(pin)
  const d = [...pin].map(Number)
  const steps = new Set(d.slice(1).map((x, i) => x - d[i]!))
  if (steps.size === 1 && [0, 1, -1].includes([...steps][0]!)) throw new Error('PIN is too easy to guess')
}

/**
 * scrypt over PIN ‖ pepper. The pepper lives only in the Keychain, so a copy of the db alone has
 * nothing to guess against. The joined buffer is zeroed; its base64 string can't be (preflight F25).
 */
export async function derivePinKey(pin: string, pepper: Buffer, params: KdfParams): Promise<Buffer> {
  const input = Buffer.concat([Buffer.from(pin, 'utf8'), pepper])
  try {
    return await deriveKek(input.toString('base64'), params)
  } finally {
    input.fill(0)
  }
}
