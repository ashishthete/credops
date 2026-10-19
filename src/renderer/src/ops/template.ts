import { VARIABLE_NAME } from '../../../shared/ops'

/** The `{{name}}` placeholders of a script, once each, in order. Display only: main re-validates and is the authority. */
export function placeholders(script: string): string[] {
  const names: string[] = []
  for (const m of script.matchAll(/\{\{([^{}\s]*)\}\}/g)) {
    if (VARIABLE_NAME.test(m[1]) && !names.includes(m[1])) names.push(m[1])
  }
  return names
}
