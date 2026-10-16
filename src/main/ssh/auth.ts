import { lstat, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AuthenticationType, AuthHandlerMiddleware, KeyboardInteractiveAuthMethod } from 'ssh2'
import type { IdentityRef } from '../../shared/inventory'
import type { IdentityStore } from '../vault/identity-store'
import { MAX_PRIVATE_KEY_BYTES, parsePrivateKey } from '../vault/openssh'

export type AuthMethod =
  | { type: 'agent'; agent: string }
  | { type: 'publickey'; label: string; key: string; passphrase?: string }
  | { type: 'password'; password: string }

export interface AuthPlan {
  username: string
  methods: AuthMethod[]
  /** Why a method was left out. Never holds a secret. */
  notes: string[]
  kind: 'agent' | 'key' | 'password' | 'default'
}

export interface AuthDeps {
  identities: Pick<IdentityStore, 'resolve'>
  env: Record<string, string | undefined>
  home: string
}

const DEFAULT_KEYS = ['id_ed25519', 'id_rsa'] as const

async function agentSocket(env: AuthDeps['env']): Promise<string | null> {
  const sock = env.SSH_AUTH_SOCK
  if (!sock) return null
  try {
    await stat(sock)
    return sock
  } catch {
    return null
  }
}

/** Reads one default key; returns a method, a note, or neither (missing / not a regular file). */
async function defaultKey(home: string, name: string): Promise<{ method?: AuthMethod; note?: string }> {
  const path = join(home, '.ssh', name)
  let info
  try {
    info = await lstat(path)
  } catch {
    return {}
  }
  if (info.isSymbolicLink()) return { note: `${name} is a symlink, so it was skipped` }
  if (!info.isFile()) return {}
  if (info.size > MAX_PRIVATE_KEY_BYTES) return { note: `${name} is too large to be a key` }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { note: `${name} can't be read` }
  }
  let encrypted: boolean
  try {
    encrypted = parsePrivateKey(text).encrypted
  } catch (e) {
    // PEM keys signal an encrypted key by throwing without a passphrase.
    if (e instanceof Error && e.message === 'passphrase required') encrypted = true
    else return { note: `${name} isn't a supported key` }
  }
  if (encrypted) {
    return { note: `${name} needs a passphrase: add it to ssh-agent (ssh-add) or link it in a vault` }
  }
  return { method: { type: 'publickey', label: `~/.ssh/${name}`, key: text } }
}

export async function authPlan(identity: IdentityRef, deps: AuthDeps): Promise<AuthPlan> {
  const { username } = identity
  const methods: AuthMethod[] = []
  const notes: string[] = []

  if (identity.source === 'global') {
    const sock = await agentSocket(deps.env)
    if (sock) methods.push({ type: 'agent', agent: sock })
    for (const name of DEFAULT_KEYS) {
      const r = await defaultKey(deps.home, name)
      if (r.method) methods.push(r.method)
      if (r.note) notes.push(r.note)
    }
    return { username, methods, notes, kind: 'default' }
  }

  const resolved = await deps.identities.resolve(identity.identityId)
  if (resolved.auth === 'agent') {
    const sock = await agentSocket(deps.env)
    if (sock) methods.push({ type: 'agent', agent: sock })
    else notes.push(deps.env.SSH_AUTH_SOCK ? "ssh-agent socket doesn't exist" : "ssh-agent isn't running (SSH_AUTH_SOCK is not set)")
    return { username, methods, notes, kind: 'agent' }
  }
  if (resolved.auth === 'key') {
    methods.push({
      type: 'publickey',
      label: identity.label,
      key: resolved.privateKey,
      ...(resolved.passphrase === undefined ? {} : { passphrase: resolved.passphrase }),
    })
    return { username, methods, notes, kind: 'key' }
  }
  methods.push({ type: 'password', password: resolved.password })
  return { username, methods, notes, kind: 'password' }
}

/** The server's method name for each of ours (ssh2 offers the agent as publickey). */
const SERVER_NAME: Record<AuthMethod['type'], AuthenticationType> = {
  agent: 'publickey',
  publickey: 'publickey',
  password: 'password',
}

const isLonePassword = (prompts: { echo?: boolean }[]): boolean => prompts.length === 1 && prompts[0].echo !== true

export function answerKeyboard(
  prompts: { prompt: string; echo?: boolean }[],
  password: string | undefined,
): string[] | null {
  if (password === undefined || !isLonePassword(prompts)) return null
  return [password]
}

export type KeyboardPrompt = { prompt: string; echo: boolean }
export type AskKeyboard = (name: string, instructions: string, prompts: KeyboardPrompt[]) => Promise<string[] | null>

export function authHandler(
  plan: AuthPlan,
  askPassword: () => Promise<string | null>,
  askKeyboard?: AskKeyboard,
): AuthHandlerMiddleware {
  let index = 0
  let fellBack = false
  let asked = false
  let keyboardTried = false
  const stored = plan.methods.find((m) => m.type === 'password')?.password
  // A cancelled prompt ends the attempt at the next call.
  let cancelled = false

  const ask = async (prompt: () => Promise<string[] | null>): Promise<string[] | null> => {
    try {
      return await prompt()
    } catch {
      return null
    }
  }
  const typedPassword = async (): Promise<string[] | null> => {
    const typed = await askPassword()
    return typed === null ? null : [typed]
  }

  /** `password` answers a lone password prompt in the first round only; the rest go to `askKeyboard`. */
  const keyboard = (password: string | undefined): KeyboardInteractiveAuthMethod => {
    let round = 0
    return {
      type: 'keyboard-interactive',
      username: plan.username,
      prompt: (name, instructions, _lang, prompts, finish) => {
        if (prompts.length === 0) return finish([])
        round++
        const auto = round === 1 ? answerKeyboard(prompts, password) : null
        if (auto) return finish(auto)
        const shown = prompts.map((p) => ({ prompt: p.prompt, echo: p.echo === true }))
        const lonePassword = round === 1 && password === undefined && !asked && isLonePassword(prompts)
        if (lonePassword) asked = true
        void ask(
          lonePassword ? typedPassword : async () => (askKeyboard ? askKeyboard(name, instructions, shown) : null),
        ).then((answers) => {
          if (answers === null) cancelled = true
          finish(answers ?? prompts.map(() => ''))
        })
      },
    }
  }

  return (methodsLeft, _partialSuccess, next) => {
    // ssh2 ends the attempt on `false`; its typings omit it.
    if (cancelled) return next(false as never)
    const offered = (name: AuthenticationType): boolean => !methodsLeft || methodsLeft.includes(name)
    while (index < plan.methods.length) {
      const m = plan.methods[index++]
      if (m.type === 'password' && !offered('password') && offered('keyboard-interactive')) {
        keyboardTried = true
        return next(keyboard(m.password))
      }
      if (!offered(SERVER_NAME[m.type])) continue
      if (m.type === 'agent') return next({ type: 'agent', username: plan.username, agent: m.agent })
      if (m.type === 'publickey') {
        return next({
          type: 'publickey',
          username: plan.username,
          key: m.key,
          ...(m.passphrase === undefined ? {} : { passphrase: m.passphrase }),
        })
      }
      return next({ type: 'password', username: plan.username, password: m.password })
    }
    // Nothing to try on the first call: probe with 'none' so the server lists what it accepts.
    if (!methodsLeft) return next('none')
    const canPassword = offered('password')
    const canKeyboard = offered('keyboard-interactive')
    // A stored password also goes to keyboard-interactive, even after the server refused it as `password`.
    if (canKeyboard && !keyboardTried && stored !== undefined) {
      keyboardTried = true
      return next(keyboard(stored))
    }
    if (fellBack || !(canPassword || (canKeyboard && !keyboardTried))) return next(false as never)
    fellBack = true
    // keyboard-interactive asks inside its prompt, where the server says what it wants.
    if (!canPassword) {
      keyboardTried = true
      return next(keyboard(undefined))
    }
    asked = true
    void ask(typedPassword).then((typed) => {
      if (typed === null) return next(false as never)
      next({ type: 'password', username: plan.username, password: typed[0] })
    })
  }
}
