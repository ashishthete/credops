import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { buildApp } from './app'
import { checkDataDir, loadConfig } from './config'
import { openHubDb } from './db'

async function serve(configFile: string): Promise<void> {
  const config = loadConfig(configFile)
  checkDataDir(config.dataDir)
  const db = openHubDb(join(config.dataDir, 'hub.db'))
  const app = buildApp({ config, db, now: () => new Date(), ids: randomUUID })
  const shutdown = (): void => {
    void app.close().finally(() => {
      db.close()
      process.exit(0)
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  await app.listen({ host: config.listen.host, port: config.listen.port })
}

const [cmd, flag, file] = process.argv.slice(2)
if (cmd !== 'serve' || flag !== '--config' || !file) {
  console.error('usage: opsdeck-hub serve --config <file>')
  process.exit(2)
}
serve(file).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'startup failed')
  process.exit(1)
})
