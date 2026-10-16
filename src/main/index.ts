import { join } from 'node:path'
import { homedir, hostname, userInfo } from 'node:os'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  safeStorage,
  session,
  shell,
  systemPreferences,
} from 'electron'
import { AuditLog } from './audit/audit-log'
import { openDatabase, type Db } from './db/connection'
import { createAppHandlers } from './ipc/handlers/app'
import { createAuditHandlers } from './ipc/handlers/audit'
import { createIdentityHandlers } from './ipc/handlers/identities'
import { createTunnelHandlers } from './ipc/handlers/tunnels'
import { TunnelStore } from './tunnels/tunnel-store'
import { createInventoryHandlers } from './ipc/handlers/inventory'
import { createKeyHandlers } from './ipc/handlers/keys'
import { createSecretHandlers } from './ipc/handlers/secrets'
import { createSessionHandlers } from './ipc/handlers/sessions'
import { createSshImportHandlers } from './ipc/handlers/ssh-import'
import { createVaultHandlers } from './ipc/handlers/vault'
import { isTrustedSender, registerHandlers } from './ipc/register'
import { VALIDATORS } from './ipc/validators'
import { EnvironmentStore } from './inventory/environment-store'
import { HostStore } from './inventory/host-store'
import { ProductStore } from './inventory/product-store'
import { resolveHost } from './inventory/resolve'
import { hostMeta } from './inventory/rows'
import { SshImporter } from './inventory/ssh-import'
import { redact } from './security/redact'
import { authPlan } from './ssh/auth'
import { connectChain } from './ssh/connect'
import { KnownHostStore } from './ssh/known-hosts'
import { PromptBroker } from './ssh/prompts'
import { spawnLocalShell } from './ssh/local-shell'
import { SessionManager } from './ssh/sessions'
import { AutoLock } from './vault/auto-lock'
import { IdentityStore } from './vault/identity-store'
import { KeyStore } from './vault/key-store'
import { SecretStore } from './vault/secret-store'
import { VaultService, type QuickUnlockDeps } from './vault/vault-service'
import { appMenuTemplate, devRendererUrl, forwardVaultLocks, pushEvent, shouldAllowNavigation, windowOptions } from './window'

// Keep dev data apart from the packaged app's (same name, same userData otherwise).
// Must run before anything touches userData, including the single-instance lock.
if (!app.isPackaged) app.setPath('userData', `${app.getPath('userData')}-dev`)

const devServerUrl = devRendererUrl(app.isPackaged, process.env)
const CLIPBOARD_QUIT_WAIT_MS = 500

let mainWindow: BrowserWindow | null = null
let db: Db | null = null
let audit: AuditLog | null = null
let vault: VaultService | null = null
let secrets: SecretStore | null = null
let keys: KeyStore | null = null
let identities: IdentityStore | null = null
let hosts: HostStore | null = null
let environments: EnvironmentStore | null = null
let products: ProductStore | null = null
let sessions: SessionManager | null = null
let quitAudited = false
let stopAutoLock: (() => void) | null = null

function createWindow(): void {
  const win = new BrowserWindow(windowOptions(join(__dirname, '../preload/index.js'), app.isPackaged))
  mainWindow = win

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    mainWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Hash-route changes do not fire will-navigate; anything that does would leave the app.
  win.webContents.on('will-navigate', (event, url) => {
    if (!shouldAllowNavigation(win.webContents.getURL(), url)) event.preventDefault()
  })

  if (devServerUrl) void win.loadURL(devServerUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app
    .whenReady()
    .then(() => {
      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
      session.defaultSession.setPermissionCheckHandler(() => false)
      Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(app.isPackaged, process.platform)))
      db = openDatabase(join(app.getPath('userData'), 'opsdeck.db'))
      // Decrypted values are known only while unlocked; the vault drops them on lock. Each store
      // registers its own with the vault; asking the stores first makes each decrypt its values once
      // after an unlock.
      const knownSecrets = (): readonly string[] => {
        secrets?.knownValues()
        keys?.knownValues()
        identities?.knownValues()
        return vault?.knownValues() ?? []
      }
      audit = new AuditLog(db, { knownSecrets })
      audit.append({ action: 'app.start', outcome: 'info', details: { version: app.getVersion() } })
      const log = audit
      const quick: QuickUnlockDeps = {
        keychain: {
          available: () => safeStorage.isEncryptionAvailable(),
          encrypt: (plain) => safeStorage.encryptString(plain),
          decrypt: (blob) => safeStorage.decryptString(blob),
        },
        touchId: {
          available: () => process.platform === 'darwin' && systemPreferences.canPromptTouchID(),
          prompt: (reason) => systemPreferences.promptTouchID(reason),
        },
      }
      const service = new VaultService(db, log, { quick })
      vault = service
      forwardVaultLocks(service, () => mainWindow)
      secrets = new SecretStore(db, service, log, { clipboard })
      const actor = { osUser: userInfo().username, machine: hostname() }
      keys = new KeyStore(db, service, log, {
        sshDir: join(homedir(), '.ssh'),
        clipboard,
        defaultComment: `${actor.osUser}@${actor.machine}`,
      })
      identities = new IdentityStore(db, service, keys, log)
      hosts = new HostStore(db, service, log)
      environments = new EnvironmentStore(db, service, log)
      products = new ProductStore(db, service, log)
      const tunnels = new TunnelStore({ db, audit: log, vault: service })
      const importer = new SshImporter({
        db,
        vault: service,
        audit: log,
        hosts,
        keys,
        identities,
        sshConfigPath: join(homedir(), '.ssh', 'config'),
        sshDir: join(homedir(), '.ssh'),
        home: homedir(),
        localUser: actor.osUser,
      })
      const inventoryDb = db
      const resolve = (hostId: string, environmentId?: string) =>
        resolveHost(inventoryDb, hostId, environmentId, { localUser: actor.osUser })
      const knownHosts = new KnownHostStore(db, service, log, { knownHostsPath: join(homedir(), '.ssh', 'known_hosts') })
      const authDeps = { identities, env: process.env, home: homedir() }
      const envStore = environments
      const isLocked = (): boolean => !service.isUnlocked()
      // One queue for session and tunnel prompts, so one answer channel serves both.
      const prompts = new PromptBroker({ emit: (event, payload) => pushEvent(mainWindow, event, payload), isLocked })
      sessions = new SessionManager({
        resolve,
        hostInfo: (hostId) => {
          const h = hostMeta(inventoryDb, hostId)
          return { label: h.label, keepaliveSec: h.keepaliveSec, envVars: h.envVars }
        },
        envColor: (environmentId) => envStore.list().find((e) => e.id === environmentId)?.color ?? null,
        connect: connectChain,
        plan: (identity) => authPlan(identity, authDeps),
        knownHosts,
        prompts,
        openLocal: (req) => spawnLocalShell({ ...req, env: process.env, home: homedir() }),
        audit: log,
        isLocked,
        emit: (event, payload) => pushEvent(mainWindow, event, payload),
      })
      const manager = sessions
      // Sessions keep running across a lock; connects still dialling fail, then every prompt left is
      // cancelled. Separate listeners, run in this order, so one failing never skips the other.
      service.onLock(() => manager.vaultLocked())
      service.onLock(() => prompts.cancelAll())
      stopAutoLock = new AutoLock({
        idleSeconds: () => powerMonitor.getSystemIdleTime(),
        minutes: () => service.autoLockMinutes(),
        isUnlocked: () => service.isUnlocked(),
        lock: (reason) => service.lock(reason),
      }).start()
      // vault is null once will-quit has closed the db.
      powerMonitor.on('lock-screen', () => vault?.lock('screen'))
      powerMonitor.on('suspend', () => vault?.lock('suspend'))
      powerMonitor.on('shutdown', () => vault?.lock('quit'))
      const rendererFile = join(__dirname, '../renderer/index.html')
      registerHandlers(
        ipcMain,
        {
          ...createAppHandlers(() => ({
            version: app.getVersion(),
            platform: process.platform,
            userDataPath: app.getPath('userData'),
            actor,
          })),
          ...createAuditHandlers(log, {
            saveDialog: async () => {
              const opts = { defaultPath: `opsdeck-audit-${new Date().toISOString().slice(0, 10)}.csv` }
              const res = mainWindow
                ? await dialog.showSaveDialog(mainWindow, opts)
                : await dialog.showSaveDialog(opts)
              return res.canceled ? undefined : res.filePath
            },
          }),
          ...createVaultHandlers(vault),
          ...createSecretHandlers(secrets),
          ...createKeyHandlers(keys, {
            openDialog: async (dir) => {
              const opts: Electron.OpenDialogOptions = { defaultPath: dir, properties: ['openFile', 'showHiddenFiles'] }
              const res = mainWindow
                ? await dialog.showOpenDialog(mainWindow, opts)
                : await dialog.showOpenDialog(opts)
              return res.canceled ? undefined : res.filePaths[0]
            },
          }),
          ...createIdentityHandlers(identities),
          ...createInventoryHandlers({
            hosts,
            environments,
            products,
            resolve,
          }),
          ...createSshImportHandlers(importer),
          ...createTunnelHandlers({ store: tunnels }),
          ...createSessionHandlers({ sessions: manager, prompts, knownHosts }),
        },
        (url) => isTrustedSender(url, { devServerUrl, rendererFile }),
        { validators: VALIDATORS, knownSecrets },
      )
      createWindow()
    })
    .catch((err) => {
      console.error('Startup failed:', err)
      const message = redact(err instanceof Error ? err.message : String(err))
      dialog.showErrorBox('OpsDeck could not start', message)
      app.quit()
    })

  app.on('before-quit', (event) => {
    if (!audit || quitAudited) return
    quitAudited = true
    try {
      sessions?.closeAll('quit')
    } catch (err) {
      console.error('Failed to close sessions on quit:', err)
    }
    try {
      vault?.lock('quit')
    } catch (err) {
      console.error('Failed to lock vaults on quit:', err)
    }
    try {
      audit.append({ action: 'app.quit', outcome: 'info' })
    } catch (err) {
      console.error('Failed to audit app.quit:', err)
    }
    // Hold the quit briefly so a copied secret is cleared from the clipboard; quitAudited stops a loop.
    const store = secrets
    if (store?.clipboardPending()) {
      event.preventDefault()
      void Promise.race([store.flushClipboard(), new Promise((r) => setTimeout(r, CLIPBOARD_QUIT_WAIT_MS))])
        .catch((err: unknown) => console.error('Failed to clear the clipboard on quit:', err))
        .finally(() => app.quit())
    }
  })

  app.on('will-quit', () => {
    stopAutoLock?.()
    stopAutoLock = null
    vault = null
    secrets = null
    keys = null
    identities = null
    hosts = null
    environments = null
    products = null
    sessions = null
    audit = null
    db?.close()
    db = null
  })

  // Quit on all platforms, including macOS (v1 simplicity).
  app.on('window-all-closed', () => app.quit())
}
