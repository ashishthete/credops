/** Message names the path and the rule only; it never carries the offending value. */
export class InvalidArgs extends Error {
  constructor(path: string, rule: string) {
    super(`invalid arguments: ${path} ${rule}`)
    this.name = 'InvalidArgs'
  }
}

export type Check<T> = (value: unknown, path: string) => T

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const str =
  (opts: { min?: number; max?: number; pattern?: RegExp; trim?: boolean } = {}): Check<string> =>
  (value, path) => {
    if (typeof value !== 'string') throw new InvalidArgs(path, 'must be a string')
    const s = opts.trim ? value.trim() : value
    if (opts.min !== undefined && s.length < opts.min) throw new InvalidArgs(path, `must be at least ${opts.min} chars`)
    if (opts.max !== undefined && s.length > opts.max) throw new InvalidArgs(path, `must be at most ${opts.max} chars`)
    if (opts.pattern && !opts.pattern.test(s)) throw new InvalidArgs(path, 'has an invalid format')
    return s
  }

const int =
  (opts: { min?: number; max?: number } = {}): Check<number> =>
  (value, path) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new InvalidArgs(path, 'must be an integer')
    if (opts.min !== undefined && value < opts.min) throw new InvalidArgs(path, `must be at least ${opts.min}`)
    if (opts.max !== undefined && value > opts.max) throw new InvalidArgs(path, `must be at most ${opts.max}`)
    return value
  }

const bool = (): Check<boolean> => (value, path) => {
  if (typeof value !== 'boolean') throw new InvalidArgs(path, 'must be a boolean')
  return value
}

const oneOf =
  <T extends string | number | null>(values: readonly T[]): Check<T> =>
  (value, path) => {
    if (!values.includes(value as T)) throw new InvalidArgs(path, 'is not an allowed value')
    return value as T
  }

const uuid = (): Check<string> => (value, path) => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new InvalidArgs(path, 'must be a uuid')
  return value
}

const OPTIONAL = Symbol('optional')
type Optional<T> = Check<T | undefined> & { [OPTIONAL]: true }

const optional = <T>(check: Check<T>): Optional<T> =>
  Object.assign(((value, path) => (value === undefined ? undefined : check(value, path))) as Check<T | undefined>, {
    [OPTIONAL]: true as const,
  })

const nullable =
  <T>(check: Check<T>): Check<T | null> =>
  (value, path) =>
    value === null ? null : check(value, path)

const array =
  <T>(check: Check<T>, max: number, opts: { min?: number } = {}): Check<T[]> =>
  (value, path) => {
    if (!Array.isArray(value)) throw new InvalidArgs(path, 'must be an array')
    if (opts.min !== undefined && value.length < opts.min) throw new InvalidArgs(path, `must have at least ${opts.min} item${opts.min === 1 ? '' : 's'}`)
    if (value.length > max) throw new InvalidArgs(path, `must have at most ${max} items`)
    return value.map((item, i) => check(item, `${path}[${i}]`))
  }

type Shape = Record<string, Check<unknown>>
type Infer<S extends Shape> = {
  [K in keyof S as S[K] extends Optional<unknown> ? never : K]: ReturnType<S[K]>
} & {
  [K in keyof S as S[K] extends Optional<unknown> ? K : never]?: Exclude<ReturnType<S[K]>, undefined>
}

const object =
  <S extends Shape>(shape: S): Check<Infer<S>> =>
  (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new InvalidArgs(path, 'must be an object')
    }
    const input = value as Record<string, unknown>
    for (const key of Object.keys(input)) {
      if (!Object.hasOwn(shape, key)) throw new InvalidArgs(`${path}.${key}`, 'is not an allowed key')
    }
    const out: Record<string, unknown> = {}
    for (const [key, check] of Object.entries(shape)) {
      const present = Object.hasOwn(input, key) && input[key] !== undefined
      if (!present && !(OPTIONAL in check)) throw new InvalidArgs(`${path}.${key}`, 'is required')
      if (present) out[key] = check(input[key], `${path}.${key}`)
    }
    return out as Infer<S>
  }

/**
 * A string-keyed map, copied into a fresh null-prototype object. Keys must match `keyPattern` and never name an
 * Object.prototype member (`__proto__`, `constructor`); a bad key is reported without echoing it.
 */
const record =
  <T>(keyPattern: RegExp, check: Check<T>, opts: { maxKeys: number }): Check<Record<string, T>> =>
  (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new InvalidArgs(path, 'must be an object')
    }
    const keys = Object.keys(value)
    if (keys.length > opts.maxKeys) throw new InvalidArgs(path, `must have at most ${opts.maxKeys} keys`)
    const out = Object.create(null) as Record<string, T>
    for (const key of keys) {
      if (!keyPattern.test(key) || key in Object.prototype) throw new InvalidArgs(path, 'has an invalid key')
      out[key] = check((value as Record<string, unknown>)[key], `${path}.${key}`)
    }
    return out
  }

type CheckResult<C> = C extends Check<infer T> ? T : never

/** A discriminated union: `value[tag]` picks the shape, which then checks the whole value. */
const tagged =
  <M extends Record<string, Check<unknown>>>(tag: string, shapes: M): Check<CheckResult<M[keyof M]>> =>
  (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new InvalidArgs(path, 'must be an object')
    }
    const kind = (value as Record<string, unknown>)[tag]
    if (typeof kind !== 'string' || !Object.hasOwn(shapes, kind)) throw new InvalidArgs(`${path}.${tag}`, 'is not an allowed value')
    return shapes[kind]!(value, path) as CheckResult<M[keyof M]>
  }

export const v = { str, int, bool, oneOf, optional, nullable, array, object, uuid, record, tagged }

export type ArgsValidator<A extends unknown[]> = (args: readonly unknown[]) => A

type Results<C extends Check<unknown>[]> = { [I in keyof C]: C[I] extends Check<infer T> ? T : never }

/** Validates positional args; args past the last check are dropped. */
export function args<C extends Check<unknown>[]>(...checks: C): ArgsValidator<Results<C> extends unknown[] ? Results<C> : never> {
  return ((input: readonly unknown[]) => {
    return checks.map((check, i) => check(input[i], `[${i}]`))
  }) as never
}
