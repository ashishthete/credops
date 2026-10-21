type Obj = Record<string, unknown>

const HOOK_NAME = /^(pre_hook|post_hook|c_\d+) /

const strip = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    return v
      .filter((t) => !(typeof t === 'object' && t !== null && HOOK_NAME.test(String((t as Obj).name ?? ''))))
      .map(strip)
  }
  if (typeof v !== 'object' || v === null) return v
  const o = { ...(v as Obj) }
  const vars = o.vars as Obj | undefined
  if (vars && typeof vars.d === 'object' && vars.d !== null && 'block' in o) {
    const d = { ...(vars.d as Obj) }
    delete d.pre_hook
    delete d.post_hook
    delete d.steps
    o.vars = { ...vars, d }
  }
  for (const k of Object.keys(o)) o[k] = strip(o[k])
  return o
}

/** The playbook structure with hook tasks and the per-block hook/steps vars removed (A4 comparison). */
export function structureWithoutHooks(text: string): unknown {
  return strip(JSON.parse(text))
}
