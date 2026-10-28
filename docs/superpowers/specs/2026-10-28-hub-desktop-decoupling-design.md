# CredOps — Hub and desktop decoupling: a shared source layout, and making sure Hub tests always run

Date: 2026-10-28. Extends the Phase 10 Hub work. Calls marked "(controller's
call)" were made when this spec was written; "(builder's call)" are left to
whoever plans the build. Open questions are in section 10.

Design only: nothing here is built yet.

## 1. Intent

The Hub (`hub/`) reuses the desktop's engine by reaching into the desktop
tree with relative imports (`../../src/main/deploy/release-service`,
`../../src/shared/hub`, …). That was the quickest way to get the same
generator, stores and notify code on both sides, and it works. It has four
costs:

1. **Nothing marks the boundary.** 27 files in `hub/src` import from `src/`:
   ~10 `src/shared/*` modules and ~35 `src/main/*` modules (deploy, db, ssh,
   vault, notify, ai, audit, security). A desktop refactor can break the Hub
   without anyone noticing, which leads to point 2.
2. **The Hub tests do not run with `pnpm test`.** The root `vitest.config.mts`
   has two projects, `main` (`tests/main/**`) and `renderer`. `hub/tests/**`
   (25 files: registry, releases, locks, policy, secrets, playbook-ops, …) run
   only with `vitest run --config hub/vitest.config.mts`. The root `typecheck`
   script checks `tsconfig.node.json` and `tsconfig.web.json`, not
   `hub/tsconfig.json`. There is no CI config in the repo. So a desktop change
   that breaks the Hub passes both `pnpm test` and `pnpm typecheck`.
3. **Two schemas must agree, silently.** Desktop stores (`release-store`,
   `deploy-store`, `service-store`, `runbook-store`) run against the Hub's own
   database (`HUB_MIGRATIONS` 1–11), and its tables must have the columns those
   stores use. Every new column (and each of the 2026-10-28 specs adds some)
   has to be added in both migration lists by hand.
4. **Dependency skew.** `src/main/ssh/connect.ts` imports `ssh2`, which
   resolves to the root's `ssh2 ^1.17.0` in tests and dev, but to the Hub's
   pinned `1.17.0` at runtime (the Hub bundle externalises its dependencies).
   `@anthropic-ai/sdk` is the same. Today the versions happen to match, and
   nothing checks that they keep matching.

## 2. Goals

- **G1. Hub tests and typecheck run on every `pnpm test` / `pnpm typecheck`**,
  and a guard test fails if someone removes them. This is step 0 and is worth
  doing even if nothing else in this spec happens.
- **G2. A named boundary:** `packages/shared` (browser-safe types and pure
  functions) and `packages/engine` (node-only code that both the desktop main
  process and the Hub run). The Hub imports only those two, never `src/`.
- **G3. The engine has no Electron.** It never imports `electron`,
  `src/main/ipc`, the window or the keychain. This is enforced by a test.
- **G4. A schema contract.** A test proves that every table and column engine
  stores touch exists in both the desktop and the Hub migration chains.
- **G5. Tests green at every step.** Each step is one mechanical commit, and
  old import paths keep working through re-export shims until the last step.
- **G6. No change to how the app or the Hub is built and shipped**, and no
  change to `pnpm-workspace.yaml` (see section 4.1).

## 3. Non-goals

- Publishing packages to npm.
- Splitting the Hub into its own repository.
- Changing runtime behaviour. This is a move and rename only.
- Converting to a pnpm workspace with per-package `node_modules`. That is
  possible later (Q1).

## 4. Layout

```
packages/
  shared/            @credops/shared  — today's src/shared/* (renderer-safe: no node:*, no electron)
    src/{hub,deploy,runbooks,audit,settings,services,inventory,ai,steps,deploy-error,vault,ops,…}.ts
  engine/            @credops/engine  — node-only, shared by desktop main and Hub
    src/
      db/        tx.ts, migrate.ts (the migrate() runner + Db type, split out of src/main/db/migrations.ts)
      security/  redact.ts
      audit/     audit-log.ts
      ssh/       connect.ts, known-hosts.ts, prompts.ts
      vault/     openssh.ts, crypto.ts
      notify/    teams, sink, qa, http, finalize, email, dispatcher
      ai/        claude.ts, release-notes.ts, prompt-redact.ts
      deploy/    generate, generate-ops, runner, events, markers, compose, host-vars, playbook-validate,
                 release-service, finalize, access, tooling, log-tap, local-runner, hostkeys, agent,
                 release-store, deploy-store, service-store, runbook-store, uuidv7, …
      schema/    contract.ts (section 6)
src/main/            desktop-only: index, window, ipc, vault service (keychain, Touch ID), terminal, tunnels,
                     hub client (src/main/hub/*), inventory, settings, src/main/db/migrations.ts (desktop list only)
src/renderer/        unchanged, imports @credops/shared
hub/                 stays where it is (own package.json, lockfile, deploy/), imports @credops/{shared,engine}
```

**What moves into `engine`:** exactly the closure of what `hub/src` imports
from `src/main` today, plus whatever those files import from `src/main`. The
builder computes the closure with a short script; anything that pulls in
Electron stops the move and gets split first. A grep found only three files in
`src/main` that import `electron`: `index.ts`, `window.ts` and
`ipc/register.ts`. None of them is in the Hub's closure, so the move should
need no splits (to be confirmed by the script).

### 4.1 How the packages are wired (controller's call): source aliases, not a pnpm workspace

The user's standing rule is never to commit `pnpm-workspace.yaml`, and the
root one today holds only `onlyBuiltDependencies`. So the packages are
**source folders resolved by alias**, with no `package.json` of their own in
v1:

- **TypeScript:** a shared `tsconfig.base.json` with
  `"paths": { "@credops/shared/*": ["packages/shared/src/*"],
  "@credops/engine/*": ["packages/engine/src/*"] }`. `tsconfig.node.json`,
  `tsconfig.web.json` (shared only) and `hub/tsconfig.json` extend it. The
  Hub's `include` gains `../packages/*/src/**/*`.
- **Bundlers:** `electron.vite.config.ts` (main and preload get both aliases,
  renderer gets `shared` only), `hub/vite.config.mts` and both vitest configs
  get `resolve.alias` for the same two prefixes.
- **Third-party dependencies** of engine files (`ssh2`, `@anthropic-ai/sdk`)
  resolve up the tree to the root `node_modules` in dev and tests, and to
  `hub/node_modules` at Hub runtime, as today. A **version-parity test**
  (section 7) makes the skew in point 4 a test failure instead of a surprise.
- **Hub worker threads:** `hub/tests/ts-resolve-hooks.mjs` adds extensionless
  resolution for workers. It must also map the two aliases, because workers do
  not go through vite (builder's call: a tiny `resolve` hook that rewrites
  `@credops/engine/` to the absolute folder).

## 5. Making sure Hub tests always run (step 0)

Today: `pnpm test` = `vitest run` = projects `main` + `renderer`. Hub: no.

Change:

1. **Root `vitest.config.mts`:** add the Hub's own config as a third project,
   `projects: [ {main…}, {renderer…}, 'hub/vitest.config.mts' ]`. Vitest
   accepts a config path as a project. Using the Hub's file, rather than
   copying its settings, keeps `root: hub`, the
   `--disable-warning=ExperimentalWarning` execArgv for `node:sqlite`, and its
   include in one place. Give the Hub config `name: 'hub'`, so
   `vitest run --project hub` works.
2. **Install:** the Hub tests import `fastify` and `jose`, which live in
   `hub/node_modules`. Add a root script `"test:prepare": "pnpm -C hub install
   --frozen-lockfile"`. The root `postinstall` could call it, but the
   controller's call is a separate script: postinstall already runs
   `fix-node-pty-perms`, and a nested install inside postinstall is fragile.
   Document it in the README "first run" steps. Until it has been run, the
   `hub` project fails with "Cannot find package 'fastify'", which is loud and
   obvious.
3. **Typecheck:** `"typecheck": "tsc --noEmit -p tsconfig.node.json && tsc
   --noEmit -p tsconfig.web.json && tsc --noEmit -p hub/tsconfig.json"`.
4. **Guard test:** `tests/main/test-config.test.ts` imports the root vitest
   config and asserts it has projects `main`, `renderer` and `hub`. It also
   reads `package.json` and asserts that `typecheck` mentions
   `hub/tsconfig.json`. Deleting the Hub project then fails the remaining
   suite.
5. **CI (recommendation only; nothing is set up remotely by this spec):** a
   workflow that runs `pnpm install`, `pnpm test:prepare`, `pnpm typecheck`
   and `pnpm test`. A local `pre-push` hook that runs the same is the
   no-CI fallback (Q2).

Step 0 touches 3 config files and adds 1 test. It needs no code moves and can
land first, on its own.

## 6. Schema contract (G4)

`packages/engine/src/schema/contract.ts` exports
`ENGINE_SCHEMA: Record<table, column[]>`, the columns engine stores read or
write. It starts as a hand-written list, cross-checked by grepping the stores'
SQL. A test:

- builds a fresh desktop DB (`migrate(db, MIGRATIONS)`) and a fresh Hub DB
  (`migrate(db, HUB_MIGRATIONS)`) in memory;
- for each table in the contract, `PRAGMA table_info` must list every column on
  **both** sides;
- fails with "deployment_runs.rollback_mode exists in desktop migration 16 but
  in no Hub migration".

Every 2026-10-28 spec that adds a column to a shared table (image pins,
drift, canary) then fails fast if its Hub half is forgotten.

## 7. Boundary tests

- **No Electron in the engine:** walk `packages/engine/src/**` and fail on any
  import of `electron`, `src/main/`, `../../src` or `node-pty`.
- **Renderer-safe shared:** walk `packages/shared/src/**` and fail on
  `node:*`, `electron` or a relative import outside the package. This replaces
  the comment at the top of `src/shared/ai.ts` ("keep runtime code to plain
  constants and pure functions") with a check.
- **The Hub imports only packages:** walk `hub/src/**` and `hub/tests/**`,
  and fail on any import path that contains `/src/main/` or `/src/shared/`.
  This check turns on in the last step (shims removed).
- **Version parity:** for each dependency that appears in both `package.json`
  and `hub/package.json` (`ssh2`, `@anthropic-ai/sdk` today), the root range
  must accept the Hub's pinned version. Better still, the versions in
  `pnpm-lock.yaml` and `hub/pnpm-lock.yaml` must be equal (builder's call:
  parse both lockfiles).

## 8. Migration order (tests green at every step)

Each step is a single commit and runs `pnpm typecheck && pnpm test` (which
includes the Hub after step 0).

| Step | Change | Risk | Effort |
|---|---|---|---|
| **0** | Hub tests and typecheck in root scripts, guard test (section 5) | Low. May surface existing Hub type errors, which must be fixed first | 0.5 day (+ whatever breakage it reveals) |
| **1** | Freeze the surface: a test that lists today's allowed `hub → src` imports (the 27 files' imports, exactly). A new import fails until it is added to the list deliberately | None | 0.5 day |
| **2** | `tsconfig.base.json` + aliases in all bundler and test configs. No files move yet; `@credops/shared/*` points at `src/shared/*` to begin with | Low (config only) | 0.5 day |
| **3** | `git mv src/shared packages/shared/src`, then point the alias at the new place, then a codemod replaces `../shared/x`/`../../shared/x` with `@credops/shared/x` in `src/` and `hub/`. No shims are needed, because the move and the alias change land in the same commit | Medium (many files touched, mechanical) | 1 day |
| **4** | Split `src/main/db/migrations.ts`: `migrate()`, `Db` and `ENSURE_TABLE` go to `packages/engine/src/db/migrate.ts`. The desktop `MIGRATIONS` stay. Hub `db.ts` imports the engine | Low | 0.5 day |
| **5** | Move the engine leaves (no `src/main` imports of their own): security/redact, db/tx, vault/{openssh,crypto}, audit/audit-log, deploy/uuidv7. Leave `export * from '@credops/engine/…'` shims at the old paths | Low | 0.5 day |
| **6** | Move notify/*, ai/*, ssh/{connect,known-hosts,prompts}, with shims | Medium (ssh worker hooks) | 1 day |
| **7** | Move deploy/* (generate, events, markers, runner, release-service, stores, …), with shims. Golden fixtures move too, or stay with a path update (builder's call) | Medium (the largest move) | 1.5 days |
| **8** | Schema contract test (section 6) | Low; may reveal real drift | 0.5–1 day |
| **9** | Switch Hub imports to `@credops/*`, turn on the "Hub imports only packages" test, remove the shims from `src/main`, and switch desktop imports with a codemod | Low | 0.5 day |

Total about 7–8 days, and each step can ship alone. Steps 0, 1 and 8 deliver
most of the safety even if the moves (3–7) are put off.

**Order relative to the other 2026-10-28 specs (controller's call):** do
**step 0 before building any of them**, because image pins, drift and canary
all change `generate.ts`, events and both migration chains. Steps 1–9 can run
after image-pinned rollback P1, to avoid a rename landing in the middle of
that work.

## 9. Build, compatibility, rollout

- **Electron build** (`electron-vite build`, `electron-builder`): aliases only,
  so the output is the same. A check: `out/main` has no reference to
  `packages/` paths after bundling.
- **Hub build** (`pnpm hub:build`): still one `credops-hub.mjs`, with
  dependencies external. The alias is resolved at build time. `hub/deploy/`
  (unit files) is unchanged.
- **Users and the Hub:** nothing changes at runtime. This is a code-layout
  change only.

## 10. Open questions for the user

- **Q1.** Do you want a real pnpm workspace later (`packages/*` with their own
  `package.json` and `workspace:*` dependencies)? It gives proper dependency
  isolation, but needs `pnpm-workspace.yaml` to change, and your rule today is
  never to commit that file. The alias approach avoids it.
- **Q2.** No CI exists. Should step 0 also add a GitHub Actions workflow (it
  only runs when you push), or a local `pre-push` hook, or neither?
- **Q3.** Should `pnpm test` fail when `hub/node_modules` is missing, or skip
  the Hub project with a loud warning? Recommendation: fail. Silent skipping is
  how we got here.
