// The config export's secret rules, shared with the import so it can tell a value the export blanked from one the
// file means. Wider than the stores' SENSITIVE_KEY (which stays as it is so stored templates and older files keep
// validating). They err toward blanking too much: a blanked value is easy to re-enter, a leaked one is not.

export const EXPORT_SECRET_NAME = /PASS|PWD|TOKEN|SECRET|KEY|CREDENTIAL|PRIVATE|AUTH|DSN|SALT|COOKIE|SESSION|WEBHOOK|CERT|SIGNATURE/i
/** A URL with a password in its userinfo, or any http(s) userinfo (a bare token), wherever it sits in the value. */
export const URL_USERINFO_VALUE = /https?:[\s\/\\]*[^\s\/\\@?#]*@|[a-z][a-z0-9+.-]*:[\s\/\\]*[^\s\/\\@]*:[^\s\/\\@]*@/i
/** A value that is exactly one secret ref: the only form the store reads as a ref. */
const WHOLE_SECRET_REF = /^\$\{secret:[^}]*\}$/
/** Query or fragment parameters, with the delimiter kept. */
const URL_PARAM = /([?&#;])([^=&#;?\s]*)=([^&#;?\s]*)/g

const noop = (): void => {}

/** Whether the export blanks a host env var with this name and value. */
export const isExportSecretVar = (key: string, value: string): boolean => value !== '' && (EXPORT_SECRET_NAME.test(key) || URL_USERINFO_VALUE.test(value))

/** Blanks the value of every query parameter whose name looks secret; `onBlank` runs for each one. */
export const blankUrlParams = (url: string, onBlank: () => void = noop): string =>
  url.replace(URL_PARAM, (m, d: string, name: string, value: string) => {
    if (value === '' || !EXPORT_SECRET_NAME.test(name)) return m
    onBlank()
    return `${d}${name}=`
  })

/**
 * One env template line as the export writes it: a line with a secret-looking name or a credentialed URL value (and
 * no `${secret:}` ref) becomes `KEY=`. A commented-out assignment (`# KEY=value`) is checked like a live one.
 */
export function blankTemplateLine(line: string, onBlank: () => void = noop): string {
  const comment = /^(\s*#+\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line.replace(/\r$/, ''))
  const eq = line.indexOf('=')
  if (!comment && (eq <= 0 || line.trimStart().startsWith('#'))) return line
  const [prefix, key, value] = comment ? [comment[1], comment[2], comment[3]] : ['', line.slice(0, eq), line.slice(eq + 1).replace(/\r$/, '')]
  if (value === '' || WHOLE_SECRET_REF.test(value)) return line
  if (!EXPORT_SECRET_NAME.test(key) && !URL_USERINFO_VALUE.test(value)) return line
  onBlank()
  return `${prefix}${key}=${line.endsWith('\r') ? '\r' : ''}`
}

export const blankTemplateLines = (template: string, onBlank: () => void = noop): string =>
  template
    .split('\n')
    .map((line) => blankTemplateLine(line, onBlank))
    .join('\n')
