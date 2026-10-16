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

const array =
  <T>(check: Check<T>, max: number): Check<T[]> =>
  (value, path) => {
    if (!Array.isArray(value)) throw new InvalidArgs(path, 'must be an array')
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

export const v = { str, int, bool, oneOf, optional, array, object, uuid }

export type ArgsValidator<A extends unknown[]> = (args: readonly unknown[]) => A

type Results<C extends Check<unknown>[]> = { [I in keyof C]: C[I] extends Check<infer T> ? T : never }

/** Validates positional args; args past the last check are dropped. */
export function args<C extends Check<unknown>[]>(...checks: C): ArgsValidator<Results<C> extends unknown[] ? Results<C> : never> {
  return ((input: readonly unknown[]) => {
    return checks.map((check, i) => check(input[i], `[${i}]`))
  }) as never
}
