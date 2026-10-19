import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { HubAudit } from './audit'
import { EntraVerifier } from './auth/entra'
import { buildApp } from './app'
import { checkDataDir, loadConfig } from './config'
import { openHubDb } from './db'
import { createMasterKeyFile, loadMasterKey } from './secrets/keyring'

async function serve(configFile: string): Promise<void> {
  const config = loadConfig(configFile)
  checkDataDir(config.dataDir)
  const masterKey = loadMasterKey({ ...(config.masterKeyFile ? { file: config.masterKeyFile } : {}) })
  const db = openHubDb(join(config.dataDir, 'hub.db'))
  const audit = new HubAudit(db)
  const app = buildApp({ config, db, audit, masterKey, verifier: new EntraVerifier(config.entra), now: () => new Date(), ids: randomUUID })
  const shutdown = (): void => {
    void app.close().finally(() => {
      db.close()
      process.exit(0)
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  await app.listen({ host: config.listen.host, port: config.listen.port })
  audit.append({ action: 'hub.start', outcome: 'info', actor: null, details: { name: config.name } })
}

const [cmd, flag, file] = process.argv.slice(2)
if (cmd === 'keygen' && flag === '--file' && file) {
  try {
    createMasterKeyFile(file)
    console.log(`master key written to ${file} (mode 600). Back it up: without it the stored secrets cannot be opened.`)
    process.exit(0)
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'keygen failed')
    process.exit(1)
  }
}
if (cmd !== 'serve' || flag !== '--config' || !file) {
  console.error('usage: opsdeck-hub serve --config <file> | opsdeck-hub keygen --file <path>')
  process.exit(2)
}
serve(file).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'startup failed')
  process.exit(1)
})
