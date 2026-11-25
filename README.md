# CredOps

A desktop app for the people who run servers: SSH terminals, tunnels and Ansible deployments in one
window, with your keys and passwords kept in a local vault.

- **Hosts and terminals.** Keep your machines in one list and open an SSH terminal on any of them.
- **Tunnels.** Local, remote and SOCKS forwards that you start and stop from the app, or copy as an `ssh`
  command.
- **Products, environments and services.** Group hosts the way your team talks about them: a product has
  environments, an environment has services, and every service runs on a host.
- **Vault.** Keys and passwords are stored encrypted on your machine and unlock with Touch ID, a PIN or a
  password.
- **Deployments.** Run Ansible releases against an environment, with history and rollback.
- **Config files.** Export your setup (without secrets) to a file and import it on another machine.
- **Hub (optional).** A small server a team can run to share deploy secrets, environment locks and release
  history. See [hub/README.md](hub/README.md).

CredOps is built with Electron, React and TypeScript. Packaged builds are currently made for macOS only.

## Requirements

- macOS (Apple silicon or Intel)
- [Node.js](https://nodejs.org) 22 or newer
- [pnpm](https://pnpm.io) 12 or newer
- Xcode Command Line Tools (`xcode-select --install`), which the native modules need
- `ansible-playbook` on your `PATH`, only if you want to run deployments

## Run it from source

1. Clone the repository and go into it:

   ```sh
   git clone https://github.com/ashishthete/credops.git
   cd credops
   ```

2. Install the dependencies:

   ```sh
   pnpm install
   ```

   If pnpm asks whether to allow build scripts, allow them for `electron`, `esbuild` and `node-pty`.

3. Start the app in development mode:

   ```sh
   pnpm dev
   ```

   The app window opens and reloads as you change the code.

## Check your changes

```sh
pnpm typecheck   # TypeScript, main and renderer
pnpm test        # the full test suite (Vitest)
```

## Build the macOS app

1. Build and package:

   ```sh
   pnpm build:mac
   ```

2. Find the result in `dist/`:
   - `CredOps-<version>-<arch>.dmg`, the installer
   - `mac-<arch>/CredOps.app`, the app on its own

3. Open the `.dmg` and drag CredOps into Applications.

### "CredOps Not Opened" on first launch

The build is signed ad hoc, not with an Apple Developer ID, and it is not notarised. macOS therefore blocks
it the first time you open a copy that was downloaded or shared. To allow it, do one of these:

- Open **System Settings > Privacy & Security**, scroll to the message about CredOps and choose
  **Open Anyway**.
- Or remove the quarantine flag in a terminal:

  ```sh
  xattr -dr com.apple.quarantine /Applications/CredOps.app
  ```

## Where your data lives

CredOps keeps its database and vault in `~/Library/Application Support/credops/`. A copy started with
`pnpm dev` uses `~/Library/Application Support/credops-dev/` instead, so development never touches your real
data. Nothing is sent anywhere
unless you connect the app to a Hub or turn on a feature that calls an outside service.

## Project layout

| Path | What it holds |
| --- | --- |
| `src/main` | The Electron main process: database, SSH, tunnels, vault, deployments |
| `src/preload` | The bridge between the main process and the window |
| `src/renderer` | The React user interface |
| `src/shared` | Types and helpers used by both sides |
| `tests` | Vitest suites for the main process and the interface |
| `hub` | The optional team server, with its own [runbook](hub/README.md) |
| `docs` | Design notes and plans |
| `scripts`, `build`, `resources` | Build helpers and app icons |

## The Hub

To build the team server:

```sh
pnpm hub:build   # writes hub/dist/credops-hub.mjs
```

Then follow [hub/README.md](hub/README.md) to install and configure it on a server. The Hub needs
Node.js 24 or newer.
