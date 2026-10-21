import { describe, expect, it } from 'vitest'
import { checkForm, formFrom, toPatch } from '../../src/renderer/src/deploy/form'
import { deploymentMeta } from './helpers'

// Fake values only.
describe('deploy form and a legacy repo URL', () => {
  it('never shows the credentials, and leaving the field alone keeps the stored value', () => {
    const d = deploymentMeta({ id: 'd1', repoUrl: 'https://tok:pw@host/r' })
    const form = formFrom(d)
    expect(form.repoUrl).toBe('https://host/r')
    expect(checkForm(form).errors.repoUrl).toBeUndefined()
    expect(toPatch({ ...form, name: 'renamed' }, d)).toEqual({ name: 'renamed' })
  })

  it('a value no rule can read is shown blank and kept when left blank', () => {
    const d = deploymentMeta({ id: 'd1', repoUrl: 'git@https://tok:pw@host/a' })
    const form = formFrom(d)
    expect(form.repoUrl).toBe('')
    expect(toPatch(form, d)).toEqual({})
  })

  it('typing a credentialed URL is refused, and a replacement is sent', () => {
    const d = deploymentMeta({ id: 'd1', repoUrl: 'https://tok:pw@host/r' })
    const form = formFrom(d)
    expect(checkForm({ ...form, repoUrl: 'https://u:p@host/r' }).errors.repoUrl).toMatch(/must not contain a username or password/)
    expect(toPatch({ ...form, repoUrl: 'git@host:r.git' }, d)).toEqual({ repoUrl: 'git@host:r.git' })
  })
})
