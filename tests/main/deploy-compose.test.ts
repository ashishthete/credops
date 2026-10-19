import { describe, expect, it } from 'vitest'
import { checkComposeServices, composeArgs, composeCommand } from '../../src/main/deploy/compose'
import { shellWords } from './deploy-helpers'

const T = { composeFile: 'deploy/compose.yml', composeProject: null }
const HOSTILE = ['-f x', '--rm', 'a b', 'x;rm', '$(id)']

describe('compose helper', () => {
  it('composeArgs adds -p only when the project is set', () => {
    expect(composeArgs(T, ['build'])).toEqual(['compose', '-f', 'deploy/compose.yml', 'build'])
    expect(composeArgs({ ...T, composeProject: 'shop_prod' }, ['up', '-d'])).toEqual(['compose', '-f', 'deploy/compose.yml', '-p', 'shop_prod', 'up', '-d'])
  })

  it('composeArgs refuses option-like and shell tokens', () => {
    for (const bad of HOSTILE) {
      expect(() => composeArgs({ ...T, composeFile: bad }, ['build'])).toThrow(/compose file/)
      expect(() => composeArgs({ ...T, composeProject: bad }, ['build'])).toThrow(/compose project/)
      expect(() => composeArgs(T, ['build'], [bad])).toThrow(/compose service/)
      expect(() => composeCommand(T, ['build'], [bad])).toThrow(/compose service/)
    }
  })

  it('services are appended after sub and duplicates are refused', () => {
    expect(composeArgs(T, ['up', '-d', '--no-deps'], ['web', 'api'])).toEqual(['compose', '-f', 'deploy/compose.yml', 'up', '-d', '--no-deps', 'web', 'api'])
    expect(() => composeArgs(T, ['build'], ['web', 'web'])).toThrow(/compose service/)
    expect(() => checkComposeServices(['web', 'web'])).toThrow(/compose service/)
    expect(checkComposeServices(['web', 'fastapi-app'])).toEqual(['web', 'fastapi-app'])
    expect(() => checkComposeServices([''])).toThrow(/compose service/)
  })

  it('composeCommand quotes each token and prefixes sudo -n only when asked', () => {
    const plain = shellWords(composeCommand(T, ['up', '-d', '--no-deps'], ['web']))
    expect(plain).toEqual(['docker', 'compose', '-f', 'deploy/compose.yml', 'up', '-d', '--no-deps', 'web'])
    expect(shellWords(composeCommand(T, ['build'], [], { sudo: false }))).toEqual(['docker', 'compose', '-f', 'deploy/compose.yml', 'build'])
    expect(shellWords(composeCommand({ ...T, composeProject: 'p1' }, ['build'], ['web'], { sudo: true }))).toEqual(['sudo', '-n', 'docker', 'compose', '-f', 'deploy/compose.yml', '-p', 'p1', 'build', 'web'])
    // option-like sub tokens stay one word each
    expect(shellWords(composeCommand(T, ['up', '-d']))).toEqual(['docker', 'compose', '-f', 'deploy/compose.yml', 'up', '-d'])
  })

  it('composeCommand auto sets D from docker info and runs $D', () => {
    const words = shellWords(composeCommand({ ...T, composeProject: 'p1' }, ['logs', '--tail', '50'], ['web'], { sudo: 'auto' }))
    const run = words.indexOf('$D')
    expect(words.slice(0, run)).toEqual(['if', 'docker', 'info', '>/dev/null', '2>&1', ';', 'then', 'D=docker', ';', 'else', 'D=sudo -n docker', ';', 'fi', '&&'])
    expect(words.slice(run + 1)).toEqual(['compose', '-f', 'deploy/compose.yml', '-p', 'p1', 'logs', '--tail', '50', 'web'])
  })
})
