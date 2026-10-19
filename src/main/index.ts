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
import { createOpsHandlers } from './ipc/handlers/ops'
import { listen, realExecFile, whoHolds } from './tunnels/bind'
import { TunnelManager } from './tunnels/manager'
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
import { readSshConfigMatch } from './inventory/ssh-config'
import { SshImporter } from './inventory/ssh-import'
import { ContainerService } from './ops/containers'
import { ExecLinks } from './ops/exec-links'
import { RunManager } from './ops/run-manager'
import { SnippetStore } from './ops/snippet-store'
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
import { appMenuTemplate, devRendererUrl, dropOnRendererReset, forwardVaultLocks, pushEvent, shouldAllowNavigation, windowOptions } from './window'

// Keep dev data apart from the packaged app's (same name, same userData otherwise).
// Must run before anything touches userData, including the single-instance lock.
if (!app.isPackaged) app.setPath('userData', `${app.getPath('userData')}-dev`)
// A dev run is the stock Electron binary, so it would call itself "Electron" in the app menu,
// About and Quit. Named after userData is pinned, so the data folder stays where it was.
app.setName('OpsDeck')
app.setAboutPanelOptions({ applicationName: 'OpsDeck', applicationVersion: app.getVersion() })

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
let tunnelManager: TunnelManager | null = null
let execLinks: ExecLinks | null = null
let runManager: RunManager | null = null
let containerService: ContainerService | null = null
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

  dropOnRendererReset(win.webContents, () => containerService?.unfollowAll())

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
      // Packaged builds take build/icon.icns; a dev run shows the same icon in the Dock.
      if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(join(app.getAppPath(), 'resources', 'icon.png'))
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
      const snippets = new SnippetStore({ db, audit: log, vault: service })
      const importer = new SshImporter({
        db,
        vault: service,
        audit: log,
        hosts,
        keys,
        identities,
        tunnels,
        sshConfigPath: join(homedir(), '.ssh', 'config'),
        sshDir: join(homedir(), '.ssh'),
        home: homedir(),
        localUser: actor.osUser,
      })
      const inventoryDb = db
      // Read-only, at each resolve and connect, so edits to ~/.ssh/config apply without a restart.
      const sshConfig = readSshConfigMatch({ configPath: join(homedir(), '.ssh', 'config'), home: homedir(), sshDir: join(homedir(), '.ssh') })
      const resolve = (hostId: string, environmentId?: string) =>
        resolveHost(inventoryDb, hostId, environmentId, { localUser: actor.osUser, sshConfig })
      const knownHosts = new KnownHostStore(db, service, log, { knownHostsPath: join(homedir(), '.ssh', 'known_hosts') })
      const authDeps = { identities, env: process.env, home: homedir(), sshConfig }
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
        plan: (identity, hop) => authPlan(identity, authDeps, hop),
        knownHosts,
        prompts,
        openLocal: (req) => spawnLocalShell({ ...req, env: process.env, home: homedir() }),
        audit: log,
        isLocked,
        emit: (event, payload) => pushEvent(mainWindow, event, payload),
      })
      const manager = sessions
      const runner = new TunnelManager({
        store: tunnels,
        resolve,
        hostInfo: (hostId) => {
          const h = hostMeta(inventoryDb, hostId)
          return { label: h.label, keepaliveSec: h.keepaliveSec }
        },
        connect: connectChain,
        plan: (identity, hop) => authPlan(identity, authDeps, hop),
        knownHosts,
        prompts,
        isLocked,
        listen: (address, port, deps) =>
          listen(address, port, { whoHolds: (p) => whoHolds(p, { execFile: realExecFile }), inUseBy: deps.inUseBy }),
        audit: log,
        emit: (event, payload) => pushEvent(mainWindow, event, payload),
      })
      tunnelManager = runner
      const hostStore = hosts
      // Pooled exec-only links for runs and containers, apart from interactive sessions.
      const links = new ExecLinks({
        resolve,
        hostInfo: (hostId) => {
          const h = hostMeta(inventoryDb, hostId)
          return { label: h.label, keepaliveSec: h.keepaliveSec, envVars: h.envVars }
        },
        connect: connectChain,
        plan: (identity) => authPlan(identity, authDeps),
        knownHosts,
        prompts,
        isLocked,
      })
      execLinks = links
      const runs = new RunManager({
        links,
        snippets,
        environments: () => envStore.list(),
        hosts: () => hostStore.list(),
        isLocked,
        audit: log,
        emit: (event, payload) => pushEvent(mainWindow, event, payload),
      })
      runManager = runs
      const containers = new ContainerService({
        links,
        environments: () => envStore.list(),
        hostLabel: (hostId) => hostMeta(inventoryDb, hostId).label,
        isLocked,
        audit: log,
        emit: (event, payload) => pushEvent(mainWindow, event, payload),
      })
      containerService = containers
      tunnels.onRemoved = (id) => runner.removed(id)
      tunnels.onChanged = (before, after) => runner.changed(before, after)
      // On lock, in this order: sessions fail their dials and tunnels mark theirs to pause (both keep
      // what is connected); runs end their queued and dialling hosts as `locked` while running
      // commands finish; exec links fail their dials as `locked` and close idle links; then every
      // prompt left is cancelled. Runs go before links so each dial a run aborts is already marked
      // `locked` for that host. Separate listeners, so one failing never skips the others. Quit
      // (before-quit) stops tunnels, closes sessions, cancels runs (writing their run.finish), stops
      // container log follows, closes exec links, and only then locks the vault. Container follows
      // have no lock listener: one already open keeps streaming through a lock (new calls are
      // refused while locked), like a connected session.
      service.onLock(() => manager.vaultLocked())
      service.onLock(() => runner.vaultLocked())
      service.onLock(() => runs.vaultLocked())
      service.onLock(() => links.vaultLocked())
      service.onLock(() => prompts.cancelAll())
      // Resumes paused tunnels; the first unlock also auto-starts.
      service.onUnlock(() => runner.vaultUnlocked())
      // A reset needs no password, so nothing the old one guarded may survive it: every session
      // (local shells too, for their scrollback) and every tunnel goes before the gate opens.
      service.onReset(() => manager.closeAll('reset'))
      service.onReset(() => runner.vaultReset())
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
            tunnels: runner,
          }),
          ...createSshImportHandlers(importer),
          ...createTunnelHandlers({ store: tunnels, manager: runner }),
          ...createSessionHandlers({ sessions: manager, prompts, knownHosts }),
          ...createOpsHandlers({ snippets, runs, containers }),
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
      tunnelManager?.stopAll('quit')
    } catch (err) {
      console.error('Failed to stop tunnels on quit:', err)
    }
    try {
      sessions?.closeAll('quit')
    } catch (err) {
      console.error('Failed to close sessions on quit:', err)
    }
    // Each unfinished run writes its run.finish before the vault's lock row and app.quit.
    try {
      runManager?.closeAll()
    } catch (err) {
      console.error('Failed to cancel runs on quit:', err)
    }
    try {
      containerService?.closeAll()
    } catch (err) {
      console.error('Failed to stop container log follows on quit:', err)
    }
    try {
      execLinks?.closeAll()
    } catch (err) {
      console.error('Failed to close exec links on quit:', err)
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
    tunnelManager = null
    audit = null
    db?.close()
    db = null
  })

  // Quit on all platforms, including macOS (v1 simplicity).
  app.on('window-all-closed', () => app.quit())
}
