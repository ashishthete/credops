import { randomFillSync } from 'node:crypto'

let lastMs = -1
let counter = 0

/**
 * RFC 9562 UUIDv7: 48-bit ms timestamp, version 7, a 12-bit counter in rand_a that keeps ids monotonic
 * within one ms (and across a clock step back), variant 10, then 62 random bits.
 */
export function uuidv7(now: () => number = Date.now, rand: (b: Uint8Array) => Uint8Array = randomFillSync): string {
  let ms = Math.floor(now())
  if (ms > lastMs) {
    lastMs = ms
    counter = 0
  } else {
    // Same ms, or the clock stepped back: stay on the last ms and count up so ids keep increasing.
    ms = lastMs
    if (++counter > 0xfff) {
      ms = ++lastMs
      counter = 0
    }
  }
  const b = new Uint8Array(16)
  rand(b)
  b[0] = Math.floor(ms / 2 ** 40) & 0xff
  b[1] = Math.floor(ms / 2 ** 32) & 0xff
  b[2] = Math.floor(ms / 2 ** 24) & 0xff
  b[3] = Math.floor(ms / 2 ** 16) & 0xff
  b[4] = Math.floor(ms / 2 ** 8) & 0xff
  b[5] = ms & 0xff
  b[6] = 0x70 | (counter >> 8)
  b[7] = counter & 0xff
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Buffer.from(b).toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** The millisecond timestamp encoded in a UUIDv7. */
export function uuidv7Time(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16)
}
