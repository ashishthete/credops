import { describe, expect, it } from 'vitest'
import { CONTAINER_REF, DESTRUCTIVE_PATTERN, looksLikeSecret, VARIABLE_NAME } from '../../src/shared/ops'

describe('looksLikeSecret', () => {
  it('flags assignments, mysql passwords, url credentials, private keys and bearer tokens', () => {
    for (const text of [
      'TOKEN=abc123 ./deploy.sh',
      'export DB_PASSWORD=hunter22',
      'GITHUB_PAT = ghp_x',
      'curl -d password=hunter22 https://x',
      "PASSWD='x' run",
      'API-KEY=x',
      'SECRET=x',
      'mysql -u root -pS3cret -e "select 1"',
      'mysqldump -pS3cret db',
      'git clone https://user:pw@example.com/r.git',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      '-----BEGIN PRIVATE KEY-----',
      "curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://x",
    ]) {
      expect(looksLikeSecret(text), text).toBe(true)
    }
  })

  it('lets variables, env references and ordinary scripts through', () => {
    for (const text of [
      'TOKEN={{token}} ./deploy.sh',
      'PASSWORD=$DB_PASS mysql',
      'PASSWORD="$DB_PASS" mysql',
      'mysql -u root -p -e "select 1"',
      'mysql -P 3306 -p{{pw}}',
      'git clone https://user:{{pw}}@example.com/r.git',
      'git clone https://example.com/r.git',
      'curl --compat=1 x',
      'path=/srv/app; ls $path',
      'systemctl restart nginx',
      '[ "$TOKEN" = "" ] && exit 1',
      'Bearer {{token}}',
      '',
    ]) {
      expect(looksLikeSecret(text), text).toBe(false)
    }
  })
})

describe('DESTRUCTIVE_PATTERN', () => {
  it('matches the listed commands as words', () => {
    for (const text of [
      'rm -rf /srv/app/tmp',
      'sudo rmdir x',
      'mkfs.ext4 /dev/sdb1',
      'dd if=/dev/zero of=x',
      'shutdown -h now',
      'reboot',
      'halt',
      'poweroff',
      'kill -9 123',
      'pkill nginx',
      'killall node',
      'systemctl stop nginx',
      'systemctl  restart nginx',
      'systemctl disable nginx',
      'systemctl kill nginx',
      'service nginx stop',
      'service nginx restart',
      'docker rm web',
      'docker rmi img',
      'docker stop web',
      'docker kill web',
      'docker restart web',
      'docker prune',
      'docker system prune -f',
      'docker compose down',
      'truncate -s 0 app.log',
      'psql -c "DROP TABLE users"',
      'echo x > /dev/sda',
    ]) {
      expect(DESTRUCTIVE_PATTERN.test(text), text).toBe(true)
    }
  })

  it('leaves read-only and harmless commands alone', () => {
    for (const text of [
      'uptime',
      'df -h',
      'systemctl status nginx',
      'service nginx status',
      'docker ps --all',
      'docker logs web',
      'docker compose ps',
      'ls -la /srv/rmx',
      'cat address.txt',
      'curl -s x > /dev/null 2>&1',
      'echo x >/dev/stderr',
      'grep killer app.log',
    ]) {
      expect(DESTRUCTIVE_PATTERN.test(text), text).toBe(false)
    }
  })
})

describe('ops patterns', () => {
  it('VARIABLE_NAME and CONTAINER_REF', () => {
    expect(VARIABLE_NAME.test('unit_2')).toBe(true)
    for (const bad of ['Unit', '2a', '_a', '', 'a'.repeat(33), '__proto__', 'constructor x']) {
      expect(VARIABLE_NAME.test(bad), bad).toBe(false)
    }
    expect(CONTAINER_REF.test('compose-web-1')).toBe(true)
    expect(CONTAINER_REF.test('a'.repeat(128))).toBe(true)
    for (const bad of ['-rm', '.x', 'a b', 'a'.repeat(129), '$(x)', 'a;b', '']) {
      expect(CONTAINER_REF.test(bad), bad).toBe(false)
    }
  })
})
