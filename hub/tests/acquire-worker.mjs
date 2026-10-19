// One contender for the release lock, with its own connection to the shared database file.
import { register } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'

register('./ts-resolve-hooks.mjs', import.meta.url)
const { file, environmentId, index, gate, nowIso } = workerData
const { openHubDb } = await import('../src/db.ts')
const { EnvLocks } = await import('../src/locks.ts')

const db = openHubDb(file)
const locks = new EnvLocks(db, { now: () => new Date(nowIso) })
const flag = new Int32Array(gate)
parentPort.postMessage({ ready: index })
Atomics.wait(flag, 0, 0)
try {
  locks.acquireRelease(environmentId, `release-${index}`, { oid: `oid-${index}`, name: `User ${index}` })
  parentPort.postMessage({ index, won: true })
} catch (err) {
  parentPort.postMessage({ index, won: false, status: err.status, code: err.code, message: String(err.message) })
} finally {
  db.close()
}
