import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { homedir, hostname, userInfo } from 'node:os'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
} from 'electron'
import { AuditLog } from './audit/audit-log'
import { openDatabase, type Db } from './db/connection'
import { DB_FILE, migrateFromOpsDeck, systemMigrationDeps } from './rename-migration'
import { initialWindowState, loadWindowState, saveWindowState, WINDOW_STATE_FILE } from './window-state'
import { createAppHandlers } from './ipc/handlers/app'
import { createAuditHandlers } from './ipc/handlers/audit'
import { createConfigHandlers } from './ipc/handlers/config'
import { configFileName } from '../shared/config-file'
import { createIdentityHandlers } from './ipc/handlers/identities'
import { createDeployHandlers } from './ipc/handlers/deploy'
import { createServiceHandlers } from './ipc/handlers/services'
import { createSettingsHandlers } from './ipc/handlers/settings'
import { createNotifyHandlers, createQaHandlers } from './ipc/handlers/notify'
import { createAiHandlers } from './ipc/handlers/ai'
import { AiRequests, ClaudeClient } from './ai/claude'
import { promptContext } from './ai/prompt-redact'
import { ExplainMemory, type ExplainSources } from './ai/explain'
import { releaseNotesFinalizeStep, type NotesDeps } from './ai/release-notes'
import { MacNotifier } from './notify/macos'
import { LocalSink } from './notify/sink'
import { wireLocalNotify } from './notify/wire-local'
import { NotificationDispatcher } from './notify/dispatcher'
import { createFinalizeSteps } from './notify/finalize'
import { QaDispatcher, qaFinalizeStep } from './notify/qa'
import { IntegrationStore } from './settings/integration-store'
import { SettingsStore } from './settings/settings-store'
import { detectTools } from './deploy/tooling'
import { startPrivateAgent, type ChildLike } from './deploy/agent'
import { prepareHosts } from './deploy/hostkeys'
import { LocalRunner, nodeFs, nodeSpawn } from './deploy/local-runner'
import { startTap } from './deploy/log-tap'
import { maskEvents, maskSummary } from './deploy/mask'
import { localAllowAll } from './deploy/access'
import { HubAccess, RoutingAccess } from './hub/access'
import { HubCatalog } from './hub/catalog'
import { HubConnection } from './hub/connection'
import { SsoGate } from './auth/sso-gate'
import { hubFeedSync, LiveFeed, sleepUnlessAborted } from './hub/live'
import { HubRunner, RoutingReleases } from './hub/runner'
import { backoffMs } from './tunnels/backoff'
import { HubPublisher, toHubIntegrations } from './hub/publish'
import { createAuthHandlers } from './ipc/handlers/auth'
import { createHubHandlers, hubLinkGuard } from './ipc/handlers/hub'
import { ReleaseService } from './deploy/release-service'
import { DeployStore, dbSecretRefs } from './deploy/deploy-store'
import { ServiceStore } from './deploy/service-store'
import { RunbookStore } from './deploy/runbook-store'
import { ServiceTunnels } from './deploy/service-tunnel'
import { copyServices } from './deploy/service-copy'
import { ReleaseStore } from './deploy/release-store'
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
import { RegionStore } from './inventory/region-store'
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
import { wireVaultHooks } from './vault/hooks'
import { IdentityStore } from './vault/identity-store'
import { KeyStore } from './vault/key-store'
import { SecretStore } from './vault/secret-store'
import { VaultService, type QuickUnlockDeps } from './vault/vault-service'
import { appMenuTemplate, devRendererUrl, dropOnRendererReset, forwardVaultLocks, pushEvent, shouldAllowNavigation, windowOptions } from './window'

// Keep dev data apart from the packaged app's (same name, same userData otherwise).
// Must run before anything touches userData, including the single-instance lock.
if (!app.isPackaged) app.setPath('userData', `${app.getPath('userData')}-dev`)
// First CredOps launch: carry the OpsDeck data folder and Keychain key over (never deleting them).
try {
  migrateFromOpsDeck(
    { oldDir: join(app.getPath('appData'), app.isPackaged ? 'opsdeck' : 'opsdeck-dev'), newDir: app.getPath('userData') },
    systemMigrationDeps(process.execPath),
  )
} catch (err) {
  dialog.showErrorBox(
    "CredOps couldn't move your OpsDeck data",
    `${(err as Error).message}. Your OpsDeck data is untouched. Quit OpsDeck if it is open, then open CredOps again.`,
  )
  app.exit(1)
}
// A dev run is the stock Electron binary, so it would call itself "Electron" in the app menu,
// About and Quit. Named after userData is pinned, so the data folder stays where it was.
app.setName('CredOps')
app.setAboutPanelOptions({ applicationName: 'CredOps', applicationVersion: app.getVersion() })

const devServerUrl = devRendererUrl(app.isPackaged, process.env)

/** A port free on 127.0.0.1 right now: bind port 0, read what the OS gave, close. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      server.close(() => (addr !== null && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no free port on 127.0.0.1'))))
    })
  })
}
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
let qaService: QaDispatcher | null = null
let execLinks: ExecLinks | null = null
let runManager: RunManager | null = null
let containerService: ContainerService | null = null
let releaseService: ReleaseService | null = null
let hubConnection: HubConnection | null = null
let hubFeedStop: (() => void) | null = null
let quitConfirmed = false
let quitPrompting = false
const RELEASE_QUIT_WAIT_MS = 20_000
let quitAudited = false
let stopAutoLock: (() => void) | null = null
let stopSsoWatch: (() => void) | null = null

/**
 * A running release holds host locks, so quitting asks first and, on "Quit and cancel", cancels it
 * and waits for the unlock before quitting. True while the quit must wait: no confirmation yet,
 * or the question is already on screen (one prompt for a window close and Cmd+Q together).
 */
function holdQuitForRelease(parent: BrowserWindow | null): boolean {
  if (quitConfirmed || !releaseService?.hasActive()) return false
  if (quitPrompting) return true
  quitPrompting = true
  const svc = releaseService
  const env = svc.activeEnvironments()[0]
  const opts: Electron.MessageBoxOptions = { type: 'warning', buttons: ['Quit and cancel', 'Keep open'], defaultId: 1, cancelId: 1, message: `A release is running on ${env}. Quit and cancel it?` }
  void (parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts))
    .then(async ({ response }) => {
      if (response !== 0) return
      await Promise.race([svc.cancelAll(), new Promise((r) => setTimeout(r, RELEASE_QUIT_WAIT_MS))])
      quitConfirmed = true
      app.quit()
    })
    .catch((err: unknown) => console.error('Failed to cancel releases on quit:', err))
    .finally(() => {
      quitPrompting = false
    })
  return true
}

/** Startup has registered the IPC handlers, so a window can be (re)made. */
let appStarted = false

/** Brings the window forward, or makes a new one when there is none (Dock click, second launch). */
function showMainWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    return
  }
  // IPC handlers are registered once at startup; createWindow only builds the window and its own listeners.
  if (appStarted) createWindow()
}

function createWindow(): void {
  const stateFile = join(app.getPath('userData'), WINDOW_STATE_FILE)
  const opening = initialWindowState(
    loadWindowState(stateFile),
    screen.getAllDisplays().map((d) => d.workArea),
    screen.getPrimaryDisplay().workArea,
  )
  const win = new BrowserWindow({ ...windowOptions(join(__dirname, '../preload/index.js'), app.isPackaged), ...opening.bounds })
  mainWindow = win

  win.on('ready-to-show', () => {
    if (opening.maximized) win.maximize()
    win.show()
    if (opening.fullScreen) win.setFullScreen(true)
  })
  // Closing the window quits the app (window-all-closed), so a running release is asked about
  // here, while the window is still there for "Keep open" to leave in place.
  win.on('close', (event) => {
    if (holdQuitForRelease(win)) {
      event.preventDefault()
      return
    }
    try {
      saveWindowState(stateFile, { bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() })
    } catch {
      /* best effort */
    }
  })
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
  app.on('second-instance', () => showMainWindow())
  app.on('activate', () => showMainWindow())

  app
    .whenReady()
    .then(() => {
      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
      session.defaultSession.setPermissionCheckHandler(() => false)
      Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(app.isPackaged, process.platform)))
      // Packaged builds take build/icon.icns; a dev run shows the same icon in the Dock.
      if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(join(app.getAppPath(), 'resources', 'icon.png'))
      db = openDatabase(join(app.getPath('userData'), DB_FILE))
      // Decrypted values are known only while unlocked; the vault drops them on lock. Each store
      // registers its own with the vault; asking the stores first makes each decrypt its values once
      // after an unlock.
      const knownSecrets = (): readonly string[] => {
        secrets?.knownValues()
        keys?.knownValues()
        identities?.knownValues()
        const hubTokens = hubConnection?.knownValues() ?? []
        return [...hubTokens, ...(vault?.knownValues() ?? [])]
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
      const regions = new RegionStore(db, service, log)
      const tunnels = new TunnelStore({ db, audit: log, vault: service })
      const settingsStore = new SettingsStore({ db, audit: log, vault: service, secrets })
      const integrations = new IntegrationStore({ db, audit: log, vault: service, secrets })
      const macNotifier = new MacNotifier({
        Notification,
        enabled: () => settingsStore.get().macos,
        onClick: (route) => {
          if (!mainWindow) return
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
          pushEvent(mainWindow, 'app:navigate', { route })
        },
      })
      const notifySink = new LocalSink({
        secrets,
        settings: settingsStore,
        integrations,
        fetch: globalThis.fetch,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        notifier: macNotifier,
        knownSecrets,
      })
      const notifyDispatcher = new NotificationDispatcher({
        db,
        sink: notifySink,
        integrations,
        settings: settingsStore,
        vault: service,
        audit: log,
        // The release service is built below; the dispatcher reads it only when an event arrives.
        runs: { runMeta: (id, status) => release.runMeta(id, status) },
        tunnels,
        knownSecrets,
      })
      notifyDispatcher.onSent((record) => pushEvent(mainWindow, 'notify:sent', record))
      service.onUnlock(() => void notifyDispatcher.flushPending())
      const qa = new QaDispatcher({
        secrets,
        settings: settingsStore,
        integrations,
        fetch: globalThis.fetch,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        audit: log,
        dispatcher: notifyDispatcher,
        runs: { runMeta: (id) => release.runMeta(id) },
        knownSecrets,
      })
      qaService = qa
      qa.onState((item) => pushEvent(mainWindow, 'qa:state', item))
      const aiRequests = new AiRequests()
      const claude = new ClaudeClient({ settings: settingsStore, secrets, vault: service, knownSecrets })
      const notesIdentities = identities
      const notesHosts = hosts
      const notesDeps: NotesDeps = {
        claude,
        audit: log,
        redaction: () => promptContext({ knownSecrets, identities: notesIdentities, hosts: notesHosts }),
        environmentName: (id) => integrations.environmentName(id),
      }
      const snippets = new SnippetStore({ db, audit: log, vault: service })
      const deploys = new DeployStore({ db, audit: log, vault: service, secrets: dbSecretRefs(db) })
      deploys.onChanged = (environmentId) => pushEvent(mainWindow, 'deploy:changed', { environmentId })
      const services = new ServiceStore({ db, audit: log, vault: service })
      services.onChanged = (environmentId) => pushEvent(mainWindow, 'deploy:changed', { environmentId })
      const runbooks = new RunbookStore({ db, audit: log, vault: service })
      runbooks.onChanged = (environmentId) => pushEvent(mainWindow, 'deploy:changed', { environmentId })
      const copyDeps = { db, deploys, services, audit: log, vault: service }
      const releaseStore = new ReleaseStore({ db, regions: true })
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
      const toolDeps = {
        env: process.env,
        home: homedir(),
        execFile: (file: string, args: string[]) =>
          new Promise<{ stdout: string; stderr: string }>((resolve, reject) =>
            execFile(file, args, { timeout: 10_000 }, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout: String(stdout), stderr: String(stderr) }))),
          ),
        exists: (path: string) => existsSync(path),
      }
      const localRunner = new LocalRunner({
        tools: () => detectTools(toolDeps),
        prepare: (plan, signal) =>
          prepareHosts(plan, {
            resolve: (hostId) => resolve(hostId, plan.environment.id),
            connectChain,
            prompts,
            knownHosts,
            identities: identities as IdentityStore,
            auth: { env: process.env, home: homedir(), sshConfig },
            signal,
          }),
        agent: ({ dir, tools, ttlSec }) =>
          startPrivateAgent({
            dir,
            tools,
            ttlSec,
            spawn: (file, args, o) => spawn(file, args, { env: o.env, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ChildLike,
          }),
        tap: startTap,
        spawn: nodeSpawn({ spawn: (file, args, o) => spawn(file, args, o) as never, kill: (pid, signal) => void process.kill(pid, signal as NodeJS.Signals) }),
        fs: nodeFs,
        // The agent socket must fit in 103 bytes; macOS's os.tmpdir() does not.
        tmpdir: '/tmp',
        home: homedir(),
        userAgentSock: process.env.SSH_AUTH_SOCK ?? null,
        sshConfig,
      })
      // Built right after the Hub it asks; beforeLink fails closed until then.
      let ssoGateRef: SsoGate | null = null
      const hub = new HubConnection({
        db,
        audit: log,
        keychain: quick.keychain,
        fetch: globalThis.fetch,
        openBrowser: (url) => shell.openExternal(url),
        now: () => Date.now(),
        emit: (status) => pushEvent(mainWindow, 'hub:state', status),
        beforeLink: hubLinkGuard(service, () => ssoGateRef),
      })
      hubConnection = hub
      // Every unlock asks the gate; a Hub that says the account is disabled locks the vaults at once.
      const ssoGate = new SsoGate({ db, audit: log, hub, now: () => Date.now() })
      ssoGateRef = ssoGate
      service.setSignInGate(ssoGate)
      ssoGate.onBlocked(() => service.lock('signin'))
      const stopWatch = ssoGate.watch(() => service.isUnlocked())
      stopSsoWatch = () => {
        stopWatch()
        ssoGate.close()
      }
      const hubCatalog = new HubCatalog({ client: () => hub.client() })
      hubCatalog.onChange(() => pushEvent(mainWindow, 'hub:catalog', {}))
      hub.onState(() => hubCatalog.onStatus(hub.status()))
      const hubPublisher = new HubPublisher({
        db,
        envs: envStore,
        deploys,
        services,
        runbooks,
        knownHosts,
        secrets: secrets!,
        resolve: (hostId, environmentId) => resolve(hostId, environmentId),
        audit: log,
        vault: service,
        values: secrets!,
        client: () => hub.client(),
        hubId: () => {
          const s = hub.status()
          if (!s.linked) throw new Error('Link a Hub first')
          return s.hubId
        },
        integrations: (id) => toHubIntegrations(integrations.forEnvironment(id)),
        onChanged: () => hubCatalog.refresh().catch(() => undefined),
      })
      const hubEnvLink = db.prepare('SELECT 1 AS x FROM hub_env_links WHERE environment_id = ?')
      const isHubEnv = (environmentId: string): boolean => hubEnvLink.get(environmentId) !== undefined || hubCatalog.isHubEnv(environmentId)
      const access = new RoutingAccess({
        local: localAllowAll,
        hub: new HubAccess(hub, { now: () => Date.now() }),
        isHubTarget: isHubEnv,
      })
      const release = new ReleaseService({
        db,
        deploys,
        services,
        releases: releaseStore,
        runbooks,
        runner: localRunner,
        access,
        finalize: createFinalizeSteps({
          dispatcher: notifyDispatcher,
          notes: releaseNotesFinalizeStep(notesDeps),
          qa: qaFinalizeStep({ qa, integrations }),
        }),
        audit: log,
        vault: service,
        resolve,
        identities,
        secrets,
        knownSecrets,
        emit: (batch) => pushEvent(mainWindow, 'deploy:event', batch),
        emitState: (summary) => pushEvent(mainWindow, 'release:state', maskSummary(summary, knownSecrets())),
        actor,
        now: () => new Date(),
        clock: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
      })
      releaseService = release
      service.onLock(() => release.vaultLocked())
      wireLocalNotify(release, notifyDispatcher)
      // Startup recovery lives here (Task 7 must not add a second call): a release left preflight, running or
      // rolling back by a quit can never finish, so mark it failed (and audit it) before anything reads it.
      release.recoverInterrupted()
      // Team releases run on the Hub: its live stream feeds the same pushes as a local run, and release calls
      // for a Hub environment (or a release the Hub told us about) go to the Hub.
      const hubReleaseIds = new Set<string>()
      const hubFeed = new LiveFeed({
        client: () => hub.client(),
        renew: () => hub.renew(),
        // The feed gave up on the session: make the status say so, which also stops the feed.
        // Through the gate, so the verification goes with the session.
        onSignedOut: () => void ssoGate.signOut().catch(() => undefined),
        backoff: backoffMs,
        sleep: sleepUnlessAborted,
        push: {
          // The Hub's text reaches this desktop as the Hub sent it: mask it here, as `release:events` and `release:list` do.
          events: (batch) => pushEvent(mainWindow, 'deploy:event', maskEvents(batch, knownSecrets())),
          state: (summary) => pushEvent(mainWindow, 'release:state', maskSummary(summary, knownSecrets())),
          locks: () => pushEvent(mainWindow, 'hub:locks', {}),
          catalog: () => void hubCatalog.refresh().catch(() => undefined),
        },
        isMine: (s) => {
          const st = hub.status()
          return st.linked && st.user !== null && s.triggeredBy === `${st.user.upn}@${st.hubName}`
        },
        notifier: macNotifier,
        track: (id) => void hubReleaseIds.add(id),
        now: () => new Date(),
      })
      const syncHubFeed = hubFeedSync({ status: () => hub.status(), feed: hubFeed, ids: hubReleaseIds })
      hub.onState(syncHubFeed)
      hubFeedStop = () => hubFeed.stop()
      syncHubFeed()
      // A stored session survives a restart but the user does not: ask the Hub, best effort.
      void hub.restore().catch(() => undefined)
      void ssoGate.check().catch(() => undefined)
      const releases = new RoutingReleases({
        local: release,
        hub: new HubRunner({
          client: () => hub.client(),
          audit: log,
          ids: hubReleaseIds,
          envName: (environmentId) => hubCatalog.get(environmentId)?.environment.name,
          feed: hubFeed,
        }),
        isHubEnv,
        hubReleaseIds,
        hubActive: () => {
          const st = hub.status()
          return st.linked && st.signedIn
        },
        notice: (message) => pushEvent(mainWindow, 'hub:notice', { message }),
      })
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
      runner.onEvent((e) => void notifyDispatcher.onTunnelEvent(e))
      const hostStore = hosts
      // Pooled exec-only links for runs and containers, apart from interactive sessions.
      const links = new ExecLinks({
        resolve,
        hostInfo: (hostId) => {
          const h = hostMeta(inventoryDb, hostId)
          return { label: h.label, keepaliveSec: h.keepaliveSec, envVars: h.envVars }
        },
        connect: connectChain,
        plan: (identity, hop) => authPlan(identity, authDeps, hop),
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
      const explainSources: ExplainSources = {
        release,
        sessions: manager,
        tunnels: { get: (id) => tunnels.get(id), runtime: (id) => runner.runtime(id) },
        host: (hostId) => {
          try {
            const h = hostMeta(inventoryDb, hostId)
            return { label: h.label, os: h.osIcon }
          } catch {
            return null
          }
        },
        environment: (id) => {
          try {
            const e = envStore.get(id)
            return { name: e.name, protected: e.protected }
          } catch {
            return null
          }
        },
        sessionAuth: (hostId, environmentId) => {
          try {
            const r = resolve(hostId, environmentId ?? undefined)
            return { auth: r.identity.auth, port: r.port.value }
          } catch {
            return null
          }
        },
      }
      const serviceTunnels = new ServiceTunnels({
        services,
        tunnels,
        manager: runner,
        environments: () => envStore.list(),
        deploys,
        hostLabel: (hostId) => hostMeta(inventoryDb, hostId).label,
        freePort,
      })
      tunnels.onRemoved = (id) => runner.removed(id)
      tunnels.onChanged = (before, after) => runner.changed(before, after)
      // Lock, unlock and reset hooks (order and reasons in vault/hooks.ts). Quit (before-quit) stops
      // tunnels, closes sessions, cancels runs (writing their run.finish), stops container log
      // follows, closes exec links, and only then locks the vault.
      wireVaultHooks(service, { sessions: manager, tunnels: runner, runs, links, containers, releases: release, ai: aiRequests, prompts })
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
      const hubHandlers = createHubHandlers({ conn: hub, vault: service, gate: ssoGate, audit: log, catalog: hubCatalog, publisher: hubPublisher, onLocksChanged: () => pushEvent(mainWindow, 'hub:locks', {}) })
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
              const opts = { defaultPath: `credops-audit-${new Date().toISOString().slice(0, 10)}.csv` }
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
            regions,
            resolve,
            tunnels: runner,
            openExternal: (url) => shell.openExternal(url),
          }),
          ...createSshImportHandlers(importer),
          ...createTunnelHandlers({ store: tunnels, manager: runner }),
          ...createDeployHandlers({
            deploys,
            releases,
            tooling: () => detectTools(toolDeps),
            catalog: hubCatalog,
            published: (environmentId) => hubEnvLink.get(environmentId) !== undefined,
            playbookFile: {
              saveDialog: async (releaseId) => {
                const opts: Electron.SaveDialogOptions = { defaultPath: `credops-playbook-${releaseId.slice(0, 8)}.yml`, filters: [{ name: 'YAML', extensions: ['yml', 'yaml'] }] }
                const res = mainWindow
                  ? await dialog.showSaveDialog(mainWindow, opts)
                  : await dialog.showSaveDialog(opts)
                return res.canceled ? undefined : res.filePath
              },
              write: (path, text) => writeFile(path, text, 'utf8'),
            },
            lastReleases: () => release.latestPerEnvironment(),
            knownSecrets,
            runbooks,
          }),
          ...createServiceHandlers({
            services,
            copy: (req) => copyServices(copyDeps, req),
            deploys,
            containers,
            tunnels: serviceTunnels,
            openExternal: (url) => shell.openExternal(url),
            catalog: hubCatalog,
          }),
          ...createSettingsHandlers({ settings: settingsStore, integrations }),
          ...createQaHandlers({ qa, integrations }),
          ...createAiHandlers({
            settings: settingsStore,
            requests: aiRequests,
            notes: notesDeps,
            explain: { claude, audit: log, redaction: notesDeps.redaction, sources: explainSources, memory: new ExplainMemory() },
            onDelta: (delta) => pushEvent(mainWindow, 'ai:delta', delta),
          }),
          ...createNotifyHandlers({ db, sink: notifySink, settings: settingsStore, integrations, mac: macNotifier, audit: log, actor }),
          ...createSessionHandlers({ sessions: manager, prompts, knownHosts }),
          ...createOpsHandlers({ snippets, runs, containers }),
          ...hubHandlers,
          // Owns hub:signOut, so the gate forgets the verification too.
          ...createAuthHandlers({ vault: service, gate: ssoGate, hub }),
          ...createConfigHandlers({
            db,
            vault: service,
            audit: log,
            now: () => new Date(),
            saveDialog: async (segment) => {
              const opts: Electron.SaveDialogOptions = { defaultPath: configFileName(segment), filters: [{ name: 'JSON', extensions: ['json'] }] }
              const res = mainWindow
                ? await dialog.showSaveDialog(mainWindow, opts)
                : await dialog.showSaveDialog(opts)
              return res.canceled ? undefined : res.filePath
            },
            openDialog: async () => {
              const opts: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] }
              const res = mainWindow
                ? await dialog.showOpenDialog(mainWindow, opts)
                : await dialog.showOpenDialog(opts)
              return res.canceled ? undefined : res.filePaths[0]
            },
            // Open environment pages reload; running tunnels aren't restarted.
            onImported: (environmentIds) => {
              for (const environmentId of environmentIds) pushEvent(mainWindow, 'deploy:changed', { environmentId })
            },
          }),
        },
        (url) => isTrustedSender(url, { devServerUrl, rendererFile }),
        { validators: VALIDATORS, knownSecrets },
      )
      appStarted = true
      createWindow()
    })
    .catch((err) => {
      console.error('Startup failed:', err)
      const message = redact(err instanceof Error ? err.message : String(err))
      dialog.showErrorBox('CredOps could not start', message)
      app.quit()
    })

  app.on('before-quit', (event) => {
    // Cmd+Q comes here before any window closes; the window's close handler asks the same question.
    if (holdQuitForRelease(mainWindow)) {
      event.preventDefault()
      return
    }
    if (!audit || quitAudited) return
    quitAudited = true
    qaService?.stop()
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
      hubFeedStop?.()
    } catch (err) {
      console.error('Failed to stop the Hub live feed on quit:', err)
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
    stopSsoWatch?.()
    stopSsoWatch = null
    releaseService?.close()
    releaseService = null
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
