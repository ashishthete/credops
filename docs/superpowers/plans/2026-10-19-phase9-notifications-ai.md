# OpsDeck Phase 9: Notifications & AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every release and every dropped tunnel reaches the right people, and
every failure can be explained, all without a single secret leaving the machine:
- **Teams:** an Adaptive Card goes to an environment's incoming webhook for the
  events picked on that environment: release started, succeeded, failed and
  rolled back, and tunnel dropped and not recovered (G15).
- **macOS:** native notifications fire for the same events. Clicking one opens
  the run or the tunnel.
- **SendGrid:** an optional release email (release notes plus run facts) goes
  to the environment's `to`/`cc` after a successful release.
- **QA dispatch:** a GitHub `workflow_dispatch` runs after a release. It is
  skipped by default on `prod`, `uat` and `uat_eu`, and can wait for the
  result and send a notification.
- **Claude release notes:** notes are written from the commits in the order
  features, enhancements, fixes, hotfixes, for sales and marketing (§8.4,
  §9a). They stream into an editor before the deploy, so the user can edit
  them, and are generated without the user at finalize when the editor was
  skipped. There is a deterministic fallback, so nothing is ever lost.
- **Explain & fix:** a failed deploy step, SSH connection or tunnel sends
  **redacted** context to Claude. The answer shows the cause, the fix steps and
  the commands. Each command has *Copy* and *Run in terminal*. Running one
  always takes an explicit confirm, which needs the typed name in a protected
  environment. Nothing ever runs by itself (G14, §5).
- **Settings:** a page for AI and integrations (model, Anthropic key, SendGrid,
  GitHub, macOS), plus a Notifications section in the environment dialog.

**Architecture:**
- **Main owns every integration** (§6). New modules under `src/main/`:
  - **`settings/`:** `SettingsStore`, a key/value settings table with typed
    access, and `IntegrationStore`, the per-environment notify/email/QA config.
  - **`ai/`:**
    - `prompt-redact.ts`: the AI redaction pass;
    - `claude.ts`: the thin `ClaudeClient` over `@anthropic-ai/sdk`;
    - `release-notes.ts`: the prompt, generation and fallback;
    - `explain.ts`: the context builders and the structured answer.
  - **`notify/`:**
    - `http.ts`: one guarded `postJson`, with a timeout, bounded retries and
      redacted errors;
    - `teams.ts`: the card builder and sender;
    - `email.ts`: SendGrid;
    - `macos.ts`: the native notifier;
    - `dispatcher.ts`: routes run and tunnel events to channels, dedupes
      through `notification_log`, and queues sends while the vault is locked;
    - `qa.ts`: GitHub dispatch and the optional wait.
  - **`notify/finalize.ts`:** implements Phase 8's `FinalizeSteps` (release
    notes, Teams, email, QA) on top of the modules above.
- **Secret values are read only in main**, through `SecretStore.value(id)`, at
  the moment of sending. They are never cached past one send, never put in an
  error, and never cross IPC.
- **External sends sit behind one `NotificationSink` interface**
  (`LocalSink` in this phase). Phase 10's Hub swaps in its own sink without
  touching the dispatcher.
- **Renderer, UI only:**
  - `ai/` holds the streaming-notes hook, `ReleaseNotesEditor` and the
    `ExplainPanel` drawer;
  - `pages/settings/` holds `IntegrationsPage`;
  - the Notifications section lives in `EnvironmentDialog`;
  - Explain entry points go on the Phase 8 `FailurePanel`
    (`registerFailureAction`), `SessionEnded` and
    `TunnelCard`.

**Tech Stack:**
- Phases 1–8.
- **One new dependency:** `@anthropic-ai/sdk` pinned **exactly** at
  `0.131.0` (published 2026-09-30, more than two weeks before this plan).
- Teams, SendGrid and GitHub are plain `fetch` over HTTPS (Node 22+ global),
  injected as a dep. There are no vendor SDKs.
- The Markdown for notes is a ~120-line shared parser for the subset we write
  (headings, bullets, bold, inline code, links). It renders to React elements
  in the renderer and to escaped HTML for email. There is no Markdown
  dependency and no `innerHTML`.

**Spec:** `docs/superpowers/specs/2026-10-16-opsdeck-design.md`:
- §3 G14 (AI help), G15 (Teams + macOS);
- §5 anti-goals: no secrets in Teams or AI prompts; no AI suggestion executed
  without a click; no protected deploy without confirmation; nothing the
  release script does is lost; no animation that blocks input;
- §6 (AI, redaction, Teams decisions);
- §7 (Environment `qa_on_deploy`, `qa_workflow`, `email_to/cc`,
  `notify_events[]`, `teams_webhook_secret_id`; Release `release_notes`,
  `options`; Settings `ai_model`, `ai_api_key_secret_id`);
- §8.4 Finalize and the runner boundary;
- §8.6 AI context;
- §8.7 notifications;
- §8.9 (Hub later);
- §9 item 9;
- §9a (release notes prompt intent, audit actor);
- §10 feel.

Roadmap and contracts: `docs/superpowers/plans/2026-10-16-roadmap.md`.
Conventions: the Phase 3–5 plans in the same folder.

## Upstream interfaces (Phase 8, reconciled)

Reconciled against the real Phase 8 plans at `dec242a` on
`phase8-deployments`: `2026-10-19-phase8-deployments.md` (8a) and
`2026-10-19-phase8-deployments-8b.md` (8b). Phase 9 consumes only the names
below.

From `src/shared/deploy.ts` and `src/main/deploy/` (8a):
- **`RunEvent = RunEventBase & RunEventBody`**, where `RunEventBase` is
  `{ id /* UUIDv7 */; runId /* = releaseId */; seq; at }`. The **release id is
  the stream id**. Phase 9 reads these body types:
  - `run.started { kind: ReleaseKind; version }`;
  - `step.started { stepId; kind: StepKind; name; hostId; deploymentRunId }`;
  - `step.failed { stepId; error; durationMs }`;
  - `log { stepId; hostId; stream; line }`;
  - `preflight.done { report: PreflightReport }`;
  - `run.finished { status: 'succeeded' | 'failed' | 'rolled_back' | 'cancelled'; error? }`.
- **`CommitInfo { sha; subject; author; date; deploymentId }`.** It has no
  body. `author` is **never** sent to Claude.
- **`ReleaseOptions { backup; notify; qa }`**, with defaults `notify: true`
  and `qa: false`. Phase 8 stores `notify` and `qa` for Phase 9.
- **`ReleaseRunMeta`** (`finalize.ts`):
  - `id` (= `releaseId`), `kind`, `status`;
  - `environmentId`, `environmentName`, `productId`, `productName`;
  - `deployments: { id; name; hostId; hostLabel; status; previousCommit; deployedCommit }[]`.
    Phase 9 uses the deployment names and host *labels* from here; there is
    no single `deploymentName`;
  - `hostIds`, `version`, `previousVersion`;
  - `commits`, `options`, `releaseNotes`, **`redeploy: boolean`**;
  - `startedAt`, `finishedAt`, `actor: Actor`, `urls`.
- **`FinalizeSteps` / `FinalizeContext`**, adopted verbatim, with
  `noopFinalize` as the default:
  ```ts
  interface FinalizeContext { run: ReleaseRunMeta; log(line: string): void; signal: AbortSignal }
  interface FinalizeSteps {
    releaseNotes(ctx: FinalizeContext): Promise<string | null>
    notify(ctx: FinalizeContext): Promise<void>
    qa(ctx: FinalizeContext): Promise<void>
  }
  ```
  - They run **only after a successful release**, in the order notes →
    notify → qa.
  - The steps are `release:finalize_notes`, `release:finalize_notify` and
    `release:finalize_qa`. A throw fails only that step; the release stays
    `succeeded`.
  - Phase 9 passes `createFinalizeSteps(...)` as `ReleaseService`'s
    `finalize` dep in `index.ts`.
- **On `ReleaseService`** (main):
  - `onEvent(fn: (e: RunEvent) => void): () => void`, the main-side
    subscription;
  - `runMeta(id): ReleaseRunMeta`;
  - `detail(id): ReleaseDetail`;
  - `events(id, afterSeq, limit)`.

  The runner's own `DeployRunner.onEvent` is internal, and Phase 9 doesn't
  use it.
- **IPC used by Phase 9's renderer:**
  - `release:preflight [PreflightRequest] → { releaseId }`. The request
    carries `releaseNotes?` and `options`;
  - `release:get [releaseId] → ReleaseDetail`, with `preflight.commits` per
    deployment and `releaseNotes`;
  - the `deploy:event` batches, where commits arrive in `preflight.done`;
  - `release:start(id, { typedName, redeploy })`.
- **`composeSnippet(id)` always returns `null`**, because the compose file
  lives on the host. The run context calls it and leaves the snippet out.
  The `envBlocks` redaction path is still built and is tested with a fake
  snippet.
- **Environment columns:** Phase 8 leaves `qa_on_deploy`, `qa_workflow`,
  `email_to/cc`, `notify_events` and `teams_webhook_secret_id` to Phase 9.
  `environment_integrations` owns all of them, as specified.
- **Migrations:** by controller ruling, Phase 7 = 6, Phase 8 = 7 and **Phase
  9 = 8**. The number is never renumbered when other phase branches merge.

From 8b (renderer):
- **`registerReleaseNotesEditor(component)`** fills the `ReleaseNotesSlot`
  in the `ReleaseWizard` *Choose* step. Its value is passed to
  `release:preflight`.
- **`registerFailureAction(component)`** fills `FailurePanel` in
  `ReleaseView`, keyed by `stepId`. Task 11 mounts *Explain & fix* there.
- **Release route:** `#/deployments/release/<id>`.
- The wizard's **notify/QA toggles** are disabled with
  `Available with notifications (Phase 9)` "until Phase 9 registers them".

**Remaining gaps.** These are the only Phase 8 edits left in Phase 9. Both
are renderer-side or small, and both are listed in the owning task's commit
body:
1. **Notes need commits, but the slot sits before preflight.** The *Choose*
   step comes before preflight, so there are no commits yet.
   - Task 10 also renders `ReleaseNotesSlot` in the *Confirm* step, with the
     `releaseId` and the preflight commits. That is a one-line wizard edit.
   - It adds `release:set-notes [releaseId, notes] → void`:
     `ReleaseService.setNotes` writes `releases.release_notes` while the
     status is `ready` or `blocked`, needs the vault unlocked, and is not
     audited (no content, and the release itself is audited).
   - In *Choose*, the editor shows only the line "Notes are drafted from the
     commits after preflight".
2. **Enabling the notify/QA toggles.** 8b names no registration API. If the
   rebased code has none, Task 10 adds `registerReleaseOptions({ notify: true, qa: true })`
   next to `registerReleaseNotesEditor`, in the same registry module.

From Phase 5 (shipped): `TunnelManager.onEvent`, and `TunnelEvent` `failed`
with `wasUp: true`, meaning "dropped and not recovered".
From Phase 4 (shipped): `SessionManager` meta and `SessionError`, plus the
renderer `openSsh`, `openLocal` and `session:write`.

## Global Constraints

- **All Phase 1–8 constraints still hold:**
  - the window flags and CSP;
  - the renderer imports no Node;
  - modules under test import only *types* from `electron`;
  - every IPC channel has a validator, and validator errors name the path,
    never the value;
  - mutations call `vault.assertUnlocked()`;
  - audit is appended after COMMIT;
  - renderer mutations go through `attempt(...)`;
  - earlier migrations are never edited.
- **Commands** (`pnpm test` is broken here because `node_modules` is a symlink):
  - test: `./node_modules/.bin/vitest run [files]`;
  - typecheck: `./node_modules/.bin/tsc --noEmit -p tsconfig.node.json && ./node_modules/.bin/tsc --noEmit -p tsconfig.web.json`;
  - lint: `./node_modules/.bin/eslint .` if the binary exists. Today
    `pnpm lint` is the typecheck and there is no eslint, so typecheck is the
    gate.
  - If pnpm rewrites `pnpm-workspace.yaml`, `git checkout pnpm-workspace.yaml`.
- **Migration 8 (`notifications`)**, verbatim apart from any column Phase 8 owns:
  ```sql
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE environment_integrations(
    environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
    notify_events TEXT NOT NULL DEFAULT '[]',              -- JSON NotifyEventKey[]
    teams_webhook_secret_id TEXT REFERENCES secrets(id) ON DELETE SET NULL,
    email_to TEXT NOT NULL DEFAULT '[]', email_cc TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
    qa_on_deploy INTEGER NOT NULL DEFAULT 0 CHECK (qa_on_deploy IN (0,1)),
    qa_repo TEXT, qa_workflow TEXT, qa_ref TEXT,
    qa_wait INTEGER NOT NULL DEFAULT 0 CHECK (qa_wait IN (0,1)),
    updated_at TEXT NOT NULL,
    CHECK ((qa_repo IS NULL) = (qa_workflow IS NULL)));
  CREATE TABLE notification_log(
    id TEXT PRIMARY KEY,                                    -- UUIDv7
    at TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('release','tunnel','test')),  -- release id = run stream id
    source_id TEXT NOT NULL,
    event TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('teams','email','macos','qa')),
    status TEXT NOT NULL CHECK (status IN ('pending','sent','skipped','failed')),
    detail TEXT,                                            -- redacted, ≤ 200 chars, never a URL
    UNIQUE (source_type, source_id, event, channel));
  CREATE INDEX notification_log_at ON notification_log(at);
  ```
  - `notification_log` keeps the newest 5000 rows. Pruning runs on insert.
- **Settings keys** (JSON values; the `SETTINGS` const in `src/shared/settings.ts`):

  | Key | Default |
  |---|---|
  | `ai.model` | `'claude-opus-5-5'` |
  | `ai.apiKeySecretId` | `null` |
  | `sendgrid.apiKeySecretId` | `null` |
  | `sendgrid.from` | `null` |
  | `github.tokenSecretId` | `null` |
  | `notify.macos` | `true` |
  | `notify.macosUnscoped` | `true` (macOS alerts for tunnels with no environment) |

  The model must match `/^claude-[a-z0-9][a-z0-9.-]{0,62}$/`. Each secret id
  must name an existing secret of the right kind:

  | Setting | Secret kind |
  |---|---|
  | AI key | `api_key` |
  | SendGrid key | `api_key` |
  | GitHub token | `token` |
  | Teams webhook (per environment) | `webhook` |

  A dangling id (its secret was deleted) reads as "not configured".
- **Event keys:**
  - `NOTIFY_EVENTS = ['release.started','release.succeeded','release.failed','release.rolled_back','tunnel.failed','qa.finished'] as const`;
  - a new environment config defaults to every key except `release.started`.
- **When notifications fire** (one rule table, in `dispatcher.ts`):

  | Source | Event key |
  |---|---|
  | `run.started`, `kind: 'release'` | `release.started` |
  | `run.started`, `kind: 'rollback'` | nothing (the outcome is what matters) |
  | `run.finished` `succeeded`, `kind: 'release'` | `release.succeeded`, sent **from finalize `notify`**, once notes exist, never from the raw event |
  | `run.finished` `succeeded`, `kind: 'rollback'` (a manual rollback) | `release.rolled_back`, from the raw event, because finalize doesn't run for rollbacks |
  | `run.finished` `failed` | `release.failed` |
  | `run.finished` `rolled_back` | `release.rolled_back` |
  | `run.finished` `cancelled` | nothing |
  | `TunnelEvent` `failed` with `wasUp: true` | `tunnel.failed` |
  | QA wait finishes | `qa.finished` |

  - **Per-environment filter.** A channel gets an event only when its key is
    in that environment's `notify_events`. **Teams** also needs a webhook
    secret. **Email** goes only on `release.succeeded`, with a non-empty
    `email_to`, a SendGrid key and a `from` address. **macOS** also needs
    `notify.macos`.
  - **The run's `options.notify === false`** turns off Teams and email for
    that run. macOS still fires.
  - **Zero-commit redeploy (§8.4):** a release with `ReleaseRunMeta.redeploy === true`
    (Phase 8 sets it when zero commits were confirmed as a redeploy) sends
    no `release.started` and no `release.succeeded` on any channel, writes no
    notes and sends no email. `release.failed` and `release.rolled_back`
    still go out, because an outage is news even on a redeploy. QA follows
    the run's own `options.qa`.
  - **Tunnels with no environment:** macOS only, when
    `notify.macosUnscoped` is on.
- **Idempotency:**
  - Every (source, event, channel) sends **at most once**. The
    `notification_log` UNIQUE constraint is the guard: insert `pending` first,
    then send, then update to `sent` or `failed`.
  - A crash or duplicate event never double-posts to Teams.
- **Vault locked when an event fires** (tunnels survive a lock):
  - macOS sends at once;
  - Teams and email are logged `pending` with detail `waiting for vault unlock`;
  - on the next unlock, pending rows younger than 1 h are sent, and older ones
    become `skipped` with detail `expired while the vault was locked`.
- **HTTP** (`notify/http.ts`, used by Teams, SendGrid and GitHub):
  - **Scheme:** `https:` only. Anything else is refused before fetch with
    `<service> URL must use https`.
  - **Time limits:** a 10 s timeout per attempt through `AbortSignal.timeout`;
    up to 2 retries, only on network errors, 429 and 5xx; waits of 1 s then
    4 s, or `Retry-After` when ≤ 30 s. Waits go through an injected `sleep`.
  - **Errors:** `IntegrationError { service: 'teams'|'sendgrid'|'github'|'anthropic'; code: 'http'|'network'|'timeout'|'auth'|'config'; status?: number; message }`.
    The message is fixed text plus a status, such as
    `Teams webhook failed (HTTP 500)` or `SendGrid rejected the API key (HTTP 401)`.
    It **never** contains the URL, a header or the response body. The final
    message still passes through `redact(msg, knownSecrets)`.
  - Response bodies are read only to check status, and at most 4 KB of a
    GitHub JSON body.
- **Secrets never leak:**
  - Webhook URLs, the SendGrid key, the GitHub token and the Anthropic key are
    read through `SecretStore.value(id)` in the send call, never logged, never
    put in `notification_log`, audit, toasts, IPC results or error text.
  - Teams cards and emails hold only the §8.7 fields: environment, deployment
    name, product, host *labels*, status, version, duration, URLs, triggering
    user. They hold no logs, addresses or commands.
  - Email bodies add the release notes, which were redacted before they went
    to Claude and are redacted again before sending.
- **AI redaction pass** (`redactPrompt`, Task 2) runs on **every** string sent
  to Claude. It is the `redact()` pass with vault `knownValues()`, then:
  - **PEM blocks:** private keys, plus certificate blocks, are removed;
  - **tokens and keys:** `Bearer …`/`Basic …` values, JWTs (`eyJ…​.…​.…`),
    `sk-…`/`sk-ant-…`, `ghp_`/`gho_`/`ghs_`/`github_pat_…`, `xox[abprs]-…`,
    AWS `AKIA…`/`ASIA…` ids, `SG.…` SendGrid keys, and any 32+ char
    base64/hex run;
  - **env style:** `NAME=value` / `NAME: value` / `"name": "value"`. The value
    goes when the name matches `SENSITIVE_KEY`, or when the line comes from an
    env file or compose `environment:` block. In those, **every** value is
    redacted (§8.6);
  - **URLs:** `scheme://user:pass@` becomes `scheme://‹redacted›@`; query
    params whose name matches `SENSITIVE_KEY`, or `sig`/`signature`/`code`,
    are redacted;
  - **IP addresses:** IPv4 and IPv6 literals become **stable placeholders**
    `‹ip-1›`, `‹ip-2›` …, the same address getting the same placeholder within
    one prompt, so Claude can still reason that "the same host refused".
    Loopback, `0.0.0.0` and `::` are kept, because they matter for diagnosis;
  - **host addresses** from inventory (hostnames too) become `‹host-N›`. Host
    *labels* are kept;
  - **usernames:** the local OS user, every identity username and the
    `user@` in `user@host` become `‹user›`, and `/Users/<name>` /
    `/home/<name>` become `/Users/‹user›`;
  - **email addresses** become `‹email›`.

  The result is `{ text, counts: Record<RedactionKind, number> }`. The UI shows
  the counts ("14 values redacted"), and a *Sent to Claude* disclosure shows
  the exact redacted text.
- **Claude** (`ClaudeClient`, Task 8):
  - **SDK:** the official SDK. The client is built per call from the current
    key secret, with `maxRetries: 2` and `timeout: 120_000`.
  - **Model:** `settings['ai.model']`, default `claude-opus-5-5`. The UI shows
    the model it used.
  - **Request shape:**
    - every call sets `output_config.effort` explicitly: `'high'` for
      Explain and `'medium'` for notes;
    - `thinking: { type: 'adaptive' }`;
    - no assistant prefill.
  - **Server-side fallback:** every request goes through `client.beta.messages`
    with `betas: ['server-side-fallback-2026-07-01']` and `fallbacks: 'default'`.
    A request the primary model declines is re-run server-side. The
    *Sent to Claude* disclosure says so ("server-side fallback on").
  - **Outputs:**
    - Explain uses structured output (`output_config.format`, JSON schema)
      without streaming, `max_tokens: 16000`;
    - release notes **stream** text with `messages.stream(...)`,
      `stream.on('text')` and `finalMessage()`, at `max_tokens: 16000`;
    - both check `stop_reason`: `refusal` maps to `refused`, and `max_tokens`
      maps to `truncated` (notes keep their partial text and say so).
  - **Errors** map to `AiError { code: 'no-key'|'auth'|'rate-limit'|'network'|'refused'|'truncated'|'bad-output'|'cancelled'|'api'; message }`,
    using the SDK's typed errors (`Anthropic.AuthenticationError`,
    `RateLimitError`, `APIConnectionError`, `APIUserAbortError`,
    `APIError`). Messages are fixed text and never echo the key.
- **AI never acts:**
  - Main never executes, schedules or writes any AI-produced text to a
    session.
  - The renderer writes a command to a terminal only from the confirm
    dialog's `run`, after the user clicked *Run in terminal* and confirmed.
  - A protected environment needs the environment's name typed
    (`ConfirmDialog.typeToConfirm`), whatever the command's risk.
  - A command Claude marks `destructive` shows a red badge and its confirm
    label is `Run destructive command`.
  - Commands are never pre-filled into a terminal on open.
- **Audit** (`AUDIT_ACTIONS` gains these; actor is OS user + machine, §9a).
  These are recorded:

  | Action | `details` |
  |---|---|
  | `settings.update` | `fields` (key names only) |
  | `integration.update` | target environment, `fields` |
  | `notify.send` | `channel`, `event`, `sourceType`, `status`, `code?`; target release or tunnel |
  | `notify.test` | `channel` |
  | `qa.dispatch` | `repo`, `workflow`, `ref`, `trigger: 'deploy'|'manual'`; target environment |
  | `qa.finished` | `conclusion` |
  | `ai.release_notes` | `model`, `commits` (count), `redactions` (total), `outcome`, `trigger: 'editor'|'finalize'` |
  | `ai.explain` | `model`, `subject: 'release'|'session'|'tunnel'`, `redactions`, `outcome`; target is the subject |
  | `ai.command` | `mode: 'copy'|'run'`, `risk`, `command` (redacted, ≤ 300 chars); target host |

  These are **never** recorded:
  - prompt or response content (§8.6);
  - webhook URLs, keys or email addresses (`email_to` is recorded as a count
    only);
  - target host addresses.
- **Tests stay offline:**
  - `fetch`, the Anthropic client factory, `Notification`, `sleep`, `now` and
    ids are deps. **No test touches the network**, the real `~/.ssh` or
    `SSH_AUTH_SOCK`.
  - The SDK is faked with an object shaped like `client.beta.messages`
    (`create` and `stream`). One test builds the **real** SDK client pointed at
    a local `http.createServer` on `127.0.0.1:0` (`baseURL`), to prove the
    request shape (headers, `betas`, `fallbacks`, model) without leaving
    localhost.
- **Feel** (Phase 1 rule, §10):
  - springs from `ui/motion.ts`;
  - `useMotionSafe()` false means no transforms, no typing caret blink, no
    shimmer and no stagger, so content appears at once and state shows by
    colour and text;
  - animations never block input: the editor is typeable while a stream
    arrives, and *Stop* is always clickable.
- **Palette:**
  - `Settings: AI & integrations`;
  - `Explain last failure`, shown when a failed run, session or tunnel exists;
  - `Send test Teams message to <env>` for each environment with a webhook.

## Review Focus

1. **A secret reaches Claude, Teams or an error.** Feed a context that holds a
   vault value, a PEM key, `Authorization: Bearer …`, a JWT, `DB_PASSWORD=…`,
   a compose `environment:` block, `postgres://u:p@10.0.0.4`, the OS username
   and an identity username. None of them may survive, the IP must become
   `‹ip-1›` both times it appears, and loopback must be kept. A Teams 500 and
   a SendGrid 401 must produce errors, `notification_log.detail`, audit and
   IPC results that contain neither the URL nor the key. *Pinned:* Task 2
   `redacts every secret shape and keeps diagnosis`; Task 3 `errors never
   contain the webhook URL or key`; Task 8 `a failed call never echoes the
   key`.
2. **Double sends and lost sends.**
   - A duplicate `run.finished`, a dispatcher restart or a retry posts
     exactly once.
   - A tunnel failing while the vault is locked sends macOS at once and Teams
     after unlock, or marks Teams expired after 1 h.
   - *Pinned:* Task 6 `each event posts at most once per channel` and
     `queues Teams while locked and flushes on unlock`.
3. **Zero-commit redeploy.** No started or succeeded notification, no notes
   and no email, but a failed redeploy still notifies. *Pinned:* Task 6
   `zero-commit redeploy sends nothing on success but still reports failure`.
4. **AI output executed without consent.**
   - No code path writes Explain output to a session without the confirm.
   - A protected environment needs the typed name.
   - Cancelling writes nothing.
   - *Pinned:* Task 11 `run in terminal writes only after confirm`,
     `protected environment requires the typed name`, `cancel writes nothing`
     and `opening the panel never touches a session`.
5. **A notification failure breaks a release.** A Teams 500, a missing key or
   a GitHub 404 during finalize marks only that step failed. The run still
   finishes `succeeded`, and the version tag stays. *Pinned:* Task 6
   `finalize notify failure never fails the run`.

Also pinned:
- QA is skipped by default on `prod`, `uat` and `uat_eu` (Task 7
  `defaults qa off for prod-like environments`);
- a stream's *Stop* leaves editable text (Task 10 `stop keeps partial text`);
- reduced motion renders with no caret and no transforms (Tasks 10 and 11).

## File map

```
src/shared/settings.ts                   SETTINGS keys, IntegrationSettings, EnvironmentIntegrations, NOTIFY_EVENTS (T1)
src/shared/ai.ts                         AiError, Explanation schema + types, ExplainSubject, RedactionKind (T1)
src/shared/notes-markdown.ts             parseNotes(md) → blocks; shared by editor + email (T4)
src/main/db/migrations.ts                migration 8 'notifications' (T1)
src/main/settings/settings-store.ts      SettingsStore (T1)
src/main/settings/integration-store.ts   IntegrationStore (T1)
src/main/ipc/handlers/settings.ts        settings:* + integration:* (T1)
src/main/ai/prompt-redact.ts             redactPrompt (T2)
src/main/notify/http.ts                  postJson/getJson, IntegrationError (T3)
src/main/notify/teams.ts                 buildTeamsCard, sendTeams (T3)
src/main/notify/email.ts                 buildReleaseEmail, sendEmail (T4)
src/main/notify/macos.ts                 MacNotifier (T5)
src/main/notify/sink.ts                  NotificationSink, LocalSink (T5)
src/main/notify/dispatcher.ts            NotificationDispatcher (T6)
src/main/notify/finalize.ts              createFinalizeSteps (T6, T7, T9)
src/main/ipc/handlers/notify.ts          notify:* (T5, T6), qa:* (T7)
src/main/notify/qa.ts                    QaDispatcher (T7)
src/main/ai/claude.ts                    ClaudeClient (T8)
src/main/ai/release-notes.ts             notesPrompt, generateNotes, fallbackNotes (T9)
src/main/ai/explain.ts                   context builders, explain() (T11)
src/main/ipc/handlers/ai.ts              ai:* (T8, T9, T11)
src/renderer/src/ai/stream.ts            useAiStream (T10)
src/renderer/src/ai/ReleaseNotesEditor.tsx, NotesPreview.tsx (T10)
src/renderer/src/ai/ExplainPanel.tsx, explain-store.ts, CommandCard.tsx (T11)
src/renderer/src/pages/settings/IntegrationsPage.tsx (T12)
src/renderer/src/pages/products/EnvironmentNotifications.tsx (T12)
src/renderer/src/settings/commands.ts    palette commands (T12)
```

---

### Task 1: Migration, shared types, settings and integration stores, audit actions, IPC

**Files:**
- Create:
  - `src/shared/settings.ts`, `src/shared/ai.ts`;
  - `src/main/settings/settings-store.ts`,
    `src/main/settings/integration-store.ts`;
  - `src/main/ipc/handlers/settings.ts`.
- Modify:
  - `src/main/db/migrations.ts`;
  - `src/shared/audit.ts`;
  - `src/shared/ipc.ts`;
  - `src/main/ipc/validators.ts`;
  - `src/main/index.ts`.
- Test:
  - `tests/main/settings-store.test.ts` and
    `tests/main/integration-store.test.ts` (both new);
  - `tests/main/inventory-schema.test.ts`.

**Interfaces:**
- **Consumes:** `SecretStore.list()` (to check a secret's kind), `VaultService`
  and `AuditLog`. After the rebase, it also consumes Phase 8's environment
  columns, if any.
- **Produces, in `src/shared/settings.ts`:**
  - `NOTIFY_EVENTS`, `type NotifyEventKey`, `DEFAULT_NOTIFY_EVENTS`;
  - `PROD_LIKE = /^(prod|uat|uat_eu)$/i`;
  - `interface IntegrationSettings`, with these fields:
    - `aiModel: string`;
    - `aiApiKeySecretId: string | null`;
    - `sendgridApiKeySecretId: string | null`;
    - `sendgridFrom: string | null`;
    - `githubTokenSecretId: string | null`;
    - `macos: boolean`, `macosUnscoped: boolean`.
  - `type IntegrationSettingsPatch = Partial<IntegrationSettings>`;
  - `interface EnvironmentIntegrations`, with these fields:
    - `environmentId`;
    - `notifyEvents: NotifyEventKey[]`;
    - `teamsWebhookSecretId: string | null`;
    - `emailTo: string[]`, `emailCc: string[]`;
    - `qaOnDeploy: boolean`;
    - `qa: { repo: string; workflow: string; ref: string } | null`;
    - `qaWait: boolean`;
    - `updatedAt: string | null`.
  - `type EnvironmentIntegrationsPatch`;
  - `interface IntegrationStatus`, with these fields:
    - `ai: { configured: boolean; model: string }`;
    - `sendgrid: boolean`;
    - `github: boolean`;
    - `macosSupported: boolean`.
- **Produces, in `src/shared/ai.ts`:**
  - `AiErrorCode`, `interface AiError`;
  - `RedactionKind = 'secret'|'key'|'token'|'env'|'url'|'ip'|'host'|'user'|'email'`;
  - `type ExplainSubject = { kind: 'release'; releaseId: string; stepId: string } | { kind: 'session'; sessionId: string } | { kind: 'tunnel'; tunnelId: string }`;
  - `interface ExplainCommand { title: string; command: string; where: 'host' | 'local'; risk: 'read-only' | 'changes-state' | 'destructive' }`;
  - `interface Explanation`, with these fields:
    - `requestId`;
    - `summary`, `cause`;
    - `confidence: 'low'|'medium'|'high'`;
    - `steps: string[]`;
    - `commands: ExplainCommand[]` (≤ 8);
    - `model`;
    - `redactions: Partial<Record<RedactionKind, number>>`;
    - `sentContext: string` (the exact redacted text);
    - `target: { hostId: string | null; hostLabel: string | null; environmentId: string | null; environmentName: string | null; protected: boolean }`.
  - `EXPLANATION_SCHEMA`, the JSON schema object for `summary`, `cause`,
    `confidence`, `steps` and `commands`, with `additionalProperties: false`;
  - `parseExplanation(json): Omit<Explanation, 'requestId'|'model'|'redactions'|'sentContext'|'target'>`.
    It throws `bad-output`; it caps lengths and drops commands over 2000
    chars or holding a NUL.
- **`AUDIT_ACTIONS` gains:**
  - `settings.update`, `integration.update`;
  - `notify.send`, `notify.test`;
  - `qa.dispatch`, `qa.finished`;
  - `ai.release_notes`, `ai.explain`, `ai.command`.
- **`class SettingsStore({ db, audit, vault, secrets, now? })`:**
  - `get(): IntegrationSettings`;
  - `update(patch)`, which needs the vault unlocked and audits changed key
    names only;
  - `onChange(fn)`.
  - Errors (they never hold the value):
    - `model must look like claude-…`;
    - `secret not found`;
    - `that secret is a <kind>; pick a <expected>`;
    - `from address must be an email address`.
- **`class IntegrationStore({ db, audit, vault, secrets, now? })`:**
  - `get(environmentId)`: returns defaults when there is no row, and
    `qaOnDeploy` defaults to `!PROD_LIKE.test(env.name)` when there is a
    workflow;
  - `update(environmentId, patch)`;
  - `forEnvironment(id)` for main.
  - Errors:
    - `environment not found`;
    - `unknown notify event`;
    - `email address is not valid` (it never echoes the address);
    - `at most 20 recipients`;
    - `repo must be owner/name`;
    - `workflow must be a file name like qa.yml or a numeric id`;
    - `ref is required`.
- **IPC:**
  - `'settings:get': [] → IntegrationSettings`;
  - `'settings:update': [patch] → IntegrationSettings`;
  - `'settings:status': [] → IntegrationStatus`;
  - `'integration:get': [environmentId] → EnvironmentIntegrations`;
  - `'integration:update': [environmentId, patch] → EnvironmentIntegrations`.

- [ ] **Step 1: Write the failing tests**
  - `inventory-schema.test.ts`, test `notifications migration adds settings, integrations and log`:
    - a fresh DB reaches version 8;
    - check the three tables' columns;
    - deleting an environment cascades its integration row;
    - deleting the webhook secret sets the column to NULL;
    - a duplicate (source, event, channel) row throws UNIQUE;
    - `qa_repo` without `qa_workflow` throws CHECK.
  - `settings-store.test.ts`:
    - `returns defaults` (`aiModel 'claude-opus-5-5'`, `macos true`);
    - `update persists and audits key names only`: the audit row holds
      `fields: ['aiModel']` and never the secret id's value;
    - `rejects a secret of the wrong kind`: a `password` used as the AI key;
    - `rejects a bad model`;
    - `dangling secret reads as not configured` (via `status()`);
    - `needs the vault unlocked`.
  - `integration-store.test.ts`:
    - `defaults exclude release.started`;
    - `qaOnDeploy defaults off for prod, uat and uat_eu` (and on for `staging`);
    - `round-trips recipients and QA workflow`;
    - `rejects bad email without echoing it`;
    - `rejects unknown event`;
    - `audits integration.update with field names and recipient counts only`.
  - Validator tests:
    - `IPC validators reject bad shapes naming the path`:
      `notifyEvents: ['x']`, `emailTo: 'a'`, `aiModel: 5`.

- [ ] **Step 2: Run them and watch them fail**
  Run: `./node_modules/.bin/vitest run tests/main/inventory-schema.test.ts tests/main/settings-store.test.ts tests/main/integration-store.test.ts`
  Expected: FAIL. There is no migration and there are no stores.

- [ ] **Step 3: Implement**
  - Use the DDL from Global Constraints, minus any column Phase 8 owns.
  - Use the same store shape as `TunnelStore`, with `inTransaction` and audit
    after COMMIT.
  - Validators: `asSettingsPatch` and `asIntegrationPatch`.
  - `index.ts` constructs both stores after `SecretStore` and spreads
    `createSettingsHandlers`.

- [ ] **Step 4: Run the full suite and typecheck.** Expected: PASS.

- [ ] **Step 5: Commit**: `feat(notify): settings + integration stores, migration, shared AI/notify types`

---

### Task 2: AI prompt redaction pass

**Files:**
- Create: `src/main/ai/prompt-redact.ts`.
- Test: `tests/main/prompt-redact.test.ts` (new).

**Interfaces:**
- **Consumes:** `redact`, `REDACTED`, and `SENSITIVE_KEY` (export it from
  `redact.ts` if it isn't already).
- **Produces:**
  - `interface PromptRedactionContext`, with these fields:
    - `knownSecrets: readonly string[]`;
    - `usernames: readonly string[]`;
    - `hostAddresses: readonly string[]`;
    - `envBlocks?: boolean`, which forces all-values mode for the whole
      input; it is used for env files and compose snippets.
  - `redactPrompt(text, ctx): { text: string; counts: Partial<Record<RedactionKind, number>> }`;
  - `redactPromptParts(parts: Record<string, string>, ctx)`. It shares one
    placeholder map across parts, so `‹ip-1›` means the same thing in the log
    and in the compose snippet.
  - `promptContext(deps): PromptRedactionContext`. It builds the context from
    `vault.knownValues()`, `os.userInfo().username`, every identity username
    and every host address. These are the live values, read each call.
- **Order matters, and is fixed:**
  1. PEM blocks;
  2. known secrets;
  3. URL credentials and query params;
  4. auth headers and tokens;
  5. env assignments;
  6. emails;
  7. `user@host`;
  8. inventory host addresses;
  9. IPs;
  10. usernames in paths and as whole words.

  IPs come after hosts, so a host stored as an IP becomes `‹host-N›`, not
  `‹ip-N›`. Placeholders are never re-matched.

- [ ] **Step 1: Write the failing tests** (`prompt-redact.test.ts`):
  - **`redacts every secret shape and keeps diagnosis`.** One fixture log
    holds each item in Global Constraints → AI redaction pass:
    - the output contains none of the raw values;
    - `127.0.0.1:5432` and `0.0.0.0` survive;
    - `10.0.0.4` appears twice and becomes `‹ip-1›` both times, and
      `10.0.0.9` becomes `‹ip-2›`;
    - the counts per kind are exact.
  - `compose environment block redacts every value`: `environment:` with
    `- FOO=bar` and `BAZ: qux` loses both values, while `image:` and `ports:`
    are kept.
  - `short known secrets only at word boundaries`, mirroring `redact()`.
  - `usernames in paths and user@host`: `/Users/ashish/x` becomes
    `/Users/‹user›/x`, and `deploy@10.0.0.4` becomes `‹user›@‹host-1›` when
    `10.0.0.4` is a host address.
  - `IPv6 literals and bracketed forms`: `[fe80::1]:22` is redacted; `::1` is
    kept.
  - `idempotent`: redacting the output again changes nothing, and the counts
    are 0.
  - `parts share placeholders`.
  - `a hostile log cannot smuggle a placeholder`: a raw `‹ip-1›` in the input
    is escaped to `<ip-1>` first, so it can't alias a real address.

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Keep it pure: no I/O apart from `promptContext`.
  Patterns are module constants, and each one has a unit case.
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit**: `feat(ai): prompt redaction pass with stable placeholders`

---

### Task 3: Guarded HTTP and the Teams Adaptive Card

**Files:**
- Create: `src/main/notify/http.ts`, `src/main/notify/teams.ts`.
- Test: `tests/main/teams.test.ts` (new), `tests/main/notify-http.test.ts`
  (new).

**Interfaces:**
- **`http.ts`:**
  - `type Fetch = typeof fetch`;
  - `class IntegrationError extends Error { service; code; status? }`;
  - `postJson(url, body, { service, headers?, fetch, sleep, timeoutMs?, knownSecrets }): Promise<Response>`;
  - `getJson<T>(url, { service, headers?, fetch, sleep, knownSecrets, maxBytes? }): Promise<T>`.
  - Retries and the error text follow Global Constraints → HTTP.
- **`teams.ts`:**
  - `interface NotificationFacts`, with these fields:
    - `event: NotifyEventKey`;
    - `title: string`;
    - `environment: { name; color; protected }`;
    - `product: string | null`;
    - `deployment: string | null`;
    - `hosts: string[]` (labels);
    - `status: 'started'|'succeeded'|'failed'|'rolled_back'|'dropped'|'qa_passed'|'qa_failed'`;
    - `version: string | null`;
    - `durationSec: number | null`;
    - `urls: string[]`;
    - `actor: string` (`osUser@machine`);
    - `at: string`;
    - `notesExcerpt?: string` (≤ 600 chars, `release.succeeded` only).
  - `buildTeamsCard(facts): object` returns
    `{ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { $schema, type: 'AdaptiveCard', version: '1.5', msteams: { width: 'Full' }, body, actions } }] }`.
    - The body has a coloured header (`good`, `attention` or `warning`) and a
      `FactSet`.
    - The actions are `Action.OpenUrl` for each `https:` URL (at most 3).
    - Every string goes through the same `redact` once more.
  - `sendTeams(webhookUrl, facts, deps)`.

- [ ] **Step 1: Write the failing tests**
  - `notify-http.test.ts`:
    - `refuses non-https`;
    - `retries 5xx twice then fails with status`: the stubbed fetch returns
      500, 500, 500; there are 3 calls; the sleeps are `[1000, 4000]`;
    - `honours Retry-After on 429`;
    - `does not retry 4xx`;
    - `timeout maps to code timeout` (an aborted signal);
    - `errors never contain the URL, headers or body`: the URL
      `https://x.webhook.office.com/abc/SECRETPATH` and the body
      `SECRETBODY` appear nowhere in `err.message` or `String(err)`.
  - `teams.test.ts`:
    - `builds a succeeded card with facts and links`: a snapshot of the card
      JSON with fixed facts;
    - `failed card is attention-coloured and has no notes`;
    - `drops non-https URLs from actions`;
    - `card never contains addresses or log text`: facts built from a meta
      whose host address is `10.1.2.3` contain no `10.1.2.3`;
    - `errors never contain the webhook URL or key` (Review Focus 1).

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit**: `feat(notify): guarded https client and Teams adaptive card`

---

### Task 4: Notes Markdown and the SendGrid release email

**Files:**
- Create: `src/shared/notes-markdown.ts`, `src/main/notify/email.ts`.
- Test: `tests/main/email.test.ts` (new), `tests/renderer/notes-markdown.test.ts`
  (new; it is pure, so it can live in either tree).

**Interfaces:**
- **`notes-markdown.ts`:**
  - `type NotesBlock = { kind: 'h'; level: 2 | 3; spans: Span[] } | { kind: 'li'; spans: Span[] } | { kind: 'p'; spans: Span[] }`;
  - `type Span = { t: 'text' | 'bold' | 'code'; v: string } | { t: 'link'; v: string; href: string }`.
    A link's `href` must be `https:`; otherwise it renders as text.
  - `parseNotes(md): NotesBlock[]`;
  - `notesToHtml(blocks): string`, which HTML-escapes every text, attribute
    and href;
  - `notesToText(blocks): string`.
- **`email.ts`:**
  - `buildReleaseEmail(facts: NotificationFacts, notes: string | null, { from, to, cc }) → SendGridBody`.
    - The subject is `[<product>] <env> released <version>`, or `… redeployed`
      when there is no version.
    - The content is `text/plain` and `text/html`.
    - The HTML holds the facts table, then the notes.
  - `sendEmail(apiKey, body, deps)`. It POSTs to
    `https://api.sendgrid.com/v3/mail/send` with `Authorization: Bearer`. 202
    is success; 401/403 map to `auth`.

- [ ] **Step 1: Write the failing tests**
  - `notes-markdown.test.ts`:
    - `parses headings, bullets, bold, code, links`;
    - `escapes html in text and attributes`: `<script>` and `"` are escaped;
    - `non-https links become text`: `javascript:` and `http:`.
  - `email.test.ts`:
    - `builds subject, recipients and both bodies`;
    - `notes are redacted before sending`: a known secret inside the notes is
      masked;
    - `401 maps to auth with fixed text`;
    - `key never in error or body log`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit**: `feat(notify): shared notes markdown and SendGrid release email`

---

### Task 5: macOS notifier, NotificationSink and the test send

**Files:**
- Create: `src/main/notify/macos.ts`, `src/main/notify/sink.ts`,
  `src/main/ipc/handlers/notify.ts`.
- Modify: `src/main/index.ts` (it passes Electron's `Notification` as a dep and
  focuses and navigates the window on click), `src/shared/ipc.ts`.
- Test: `tests/main/notify-sink.test.ts` (new).

**Interfaces:**
- **`MacNotifier({ Notification: NotificationCtor, onClick })`:**
  - `NotificationCtor` is a structural type with `isSupported()` and
    `new (opts)`, plus `.on('click')` and `.show()`. Electron types are used
    as a type only.
  - `show(facts, route: string)`: the title is
    `<env> · <deployment|tunnel label> <status>`, and the body is the version
    and duration. `silent` is false for failures only.
  - Clicking emits `app:navigate`, a **new event**, with a renderer hash
    route such as `#/deployments/release/<releaseId>` or `#/tunnels?focus=<id>`.
- **`interface NotificationSink { teams(envId, facts): Promise<void>; email(envId, facts, notes): Promise<void>; macos(facts, route): void; qa?: … }`.**
  `LocalSink({ secrets, settings, integrations, fetch, sleep, Notification, knownSecrets })`
  resolves the secret values at call time.
- **IPC:**
  - `'notify:test': [target: { channel: 'teams' | 'email'; environmentId: string } | { channel: 'macos' }] → void`.
    It sends a "Test from OpsDeck" card, email or alert and audits
    `notify.test`.
  - `'notify:log': [filter: { sourceType?; sourceId?; limit? }] → NotificationRecord[]`.
  - Event `'app:navigate': { route: string }`. The renderer's `App` listens
    and calls `navigate`.

- [ ] **Step 1: Write the failing tests:**
  - `macos shows title and routes click`;
  - `macos no-op when unsupported or disabled`;
  - `test send to teams uses the env webhook secret and audits`;
  - `test send without a webhook fails with "No Teams webhook set for <env>"`;
  - `sink never returns or throws the secret`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit**: `feat(notify): macOS notifier, notification sink, test sends`

---

### Task 6: NotificationDispatcher and finalize `notify`

**Files:**
- Create: `src/main/notify/dispatcher.ts`, `src/main/notify/finalize.ts`.
- Modify: `src/main/index.ts` (subscribe to `releaseService.onEvent` and
  `tunnelManager.onEvent`, flush on `vault.onUnlock`, and pass the finalize
  steps as `ReleaseService`'s `finalize` dep), `src/main/ipc/handlers/notify.ts`,
  `src/shared/ipc.ts`.
- Test: `tests/main/notify-dispatcher.test.ts` (new).

**Interfaces:**
- **Consumes:**
  - `RunEvent`, `ReleaseRunMeta`, `FinalizeSteps` and `ReleaseService.onEvent`/`runMeta` (Phase 8a);
  - `TunnelEvent` and `TunnelManager.get(id)`;
  - `IntegrationStore`, `SettingsStore`, `NotificationSink`, `VaultService`
    and `AuditLog`;
  - the inventory stores, for environment, product and host labels.
- **`NotificationDispatcher({ db, sink, integrations, settings, vault, audit, runs, tunnels, inventory, now, ids })`:**
  - `onRunEvent(e)` and `onTunnelEvent(e)` apply the rule table;
  - `notifyRunSucceeded(run, notes)` is used by finalize;
  - `notifyQa(run, conclusion)` is used by Task 7;
  - `flushPending()` runs on unlock;
  - `factsForRun(run, status)` and `factsForTunnel(e)`;
  - `onSent(fn)` emits `notify:sent { record }` to the renderer, so a quiet
    toast can say "Teams notified".
- **`createFinalizeSteps({ dispatcher, notes, qa })`** returns `FinalizeSteps`.
  `notify(ctx)` calls `dispatcher.notifyRunSucceeded(ctx.run, ctx.run.releaseNotes)`.
  It logs one line per channel into the run, such as `Teams: sent` or
  `Email: skipped (no recipients)`. It throws only when **every** configured
  channel failed, so that step shows red.
- **Events:** `'notify:sent': NotificationRecord`, where
  `NotificationRecord = { id; at; sourceType; sourceId; event; channel; status; detail: string | null }`.

- [ ] **Step 1: Write the failing tests** (an in-memory DB, a fake sink, and
  fake runs and tunnels):
  - `run started → teams + macos when selected`;
  - `filters by environment notify_events`;
  - `options.notify false → macos only`;
  - `succeeded is sent from finalize, not from run.finished`;
  - `each event posts at most once per channel`: the same `run.finished`
    twice, plus a re-created dispatcher on the same DB, gives one sink call;
  - `zero-commit redeploy sends nothing on success but still reports failure`;
  - `tunnel dropped (wasUp true) notifies; failed before up does not`;
  - `tunnel without environment → macos only when macosUnscoped`;
  - `queues Teams while locked and flushes on unlock`:
    - macOS is immediate;
    - unlocking sends Teams once;
    - a row older than 1 h becomes `skipped` with no send;
  - `finalize notify failure never fails the run`: the sink throws on Teams
    and email succeeds; `notify` resolves and logs `Teams: failed (HTTP 500)`.
    When both throw, `notify` rejects, and the test asserts that Phase 8's
    release is still `succeeded`. Use `ReleaseService` with a fake
    `DeployRunner` (the 8a test fixture) and this module's `FinalizeSteps`,
    and assert that only `release:finalize_notify` is `failed`;
  - `audit notify.send has channel, event, status and no URL`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** No Phase 8 edit: `ReleaseService.onEvent`,
  `runMeta` and the `finalize` dep already exist in 8a.
  - `factsForRun` joins `run.deployments[].name` for the deployment field
    and uses `deployments[].hostLabel` for the hosts.
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit**: `feat(notify): dispatcher with per-env routing, dedupe, lock queue; finalize notify`

---

### Task 7: QA GitHub workflow dispatch and the optional wait

**Files:**
- Create: `src/main/notify/qa.ts`.
- Modify: `src/main/notify/finalize.ts` (`qa`),
  `src/main/ipc/handlers/notify.ts`, `src/shared/ipc.ts`, `src/main/index.ts`.
- Test: `tests/main/qa.test.ts` (new).

**Interfaces:**
- **`QaDispatcher({ secrets, settings, integrations, fetch, sleep, now, audit, dispatcher })`:**
  - `dispatch(environmentId, { trigger, releaseId? }): Promise<QaDispatch>`. It
    POSTs to `https://api.github.com/repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches`
    with `{ ref, inputs: { environment: <env name>, version?: <version> } }`
    and these headers:
    - `Accept: application/vnd.github+json`;
    - `X-GitHub-Api-Version: 2022-11-28`;
    - `Authorization: Bearer <token>`.

    204 is success.
  - `wait(d: QaDispatch, signal)`:
    - it polls `GET …/workflows/{workflow}/runs?event=workflow_dispatch&branch={ref}&per_page=10`
      every 15 s, for the first run with `created_at ≥ dispatchedAt − 5 s`,
      for up to 2 min;
    - then it polls `GET /repos/{o}/{r}/actions/runs/{id}` every 30 s, up to
      30 min, until `status === 'completed'`;
    - it returns `{ conclusion, htmlUrl }`.

    Every poll goes through the injected `sleep`.
- **`interface QaDispatch`:**
  - `{ id; environmentId; releaseId: string | null; repo; workflow; ref; dispatchedAt; state: 'dispatched' | 'running' | 'passed' | 'failed' | 'unknown'; htmlUrl: string | null }`;
  - it lives in memory and is pushed as `qa:state`.
- **Finalize `qa(ctx)`:**
  - It runs when `ctx.run.options.qa` is true and the environment has a
    workflow. The run's `options.qa` is set by the toggle in the Phase 8
    `ReleaseWizard`, which defaults to `EnvironmentIntegrations.qaOnDeploy`
    (Task 10 wires the default).
  - It logs `QA: dispatched <repo>/<workflow>@<ref>`.
  - When `qaWait` is on, the wait runs **detached** from finalize, so the run
    finishes, and `dispatcher.notifyQa` fires on `qa.finished`.
- **IPC:**
  - `'qa:dispatch': [environmentId] → QaDispatch` (manual, audited
    `trigger: 'manual'`);
  - `'qa:list': [] → QaDispatch[]`;
  - event `'qa:state': QaDispatch`.

- [ ] **Step 1: Write the failing tests:**
  - `dispatches with ref, inputs and headers`: the stubbed fetch asserts the
    URL, method, body and headers, and the token appears only in the
    `Authorization` header;
  - `defaults qa off for prod-like environments`: `prod`, `UAT` and `uat_eu`
    give `qaOnDeploy false`; `staging` gives true;
  - `skipped when run option off or no workflow`: there is no fetch call, and
    the log says `QA: skipped (off for this run)`;
  - `wait finds the run and reports conclusion`: polls with fake sleeps, then
    `qa.finished` with `failure`, then `notifyQa`;
  - `wait gives up after 30 min as unknown`;
  - `404 maps to "QA workflow not found (HTTP 404)"`;
  - the token never appears in errors.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit**: `feat(notify): QA workflow_dispatch with optional wait and notify`

---

### Task 8: Claude client over `@anthropic-ai/sdk@0.131.0`

**Files:**
- Create: `src/main/ai/claude.ts`, `src/main/ipc/handlers/ai.ts`.
- Modify:
  - `package.json`: add `"@anthropic-ai/sdk": "0.131.0"` to
    **dependencies**, exact, with no caret;
  - `pnpm-lock.yaml`;
  - `electron.vite.config.ts`, only if the SDK must be externalised for main;
  - `src/shared/ipc.ts`.
- Test: `tests/main/claude.test.ts` (new).

**Interfaces:**
- Install with `pnpm add @anthropic-ai/sdk@0.131.0 --save-exact` from the
  worktree. `node_modules` is a symlink to the main checkout, so this also
  installs it there, which is harmless. Then
  `git checkout pnpm-workspace.yaml` if pnpm touched it. **This needs the
  network once.** If the sandbox blocks it, the controller runs it.
- **`ClaudeClient({ settings, secrets, vault, factory?: (opts: { apiKey: string; maxRetries: number; timeout: number; baseURL?: string }) => AnthropicLike })`.**
  The default factory is `new Anthropic(opts)`.
  - **`complete({ system, user, schema, effort, signal }): Promise<{ json: unknown; model: string; stopReason }>`:**
    - It calls `client.beta.messages.create({ model, max_tokens: 16000, system, messages: [{ role: 'user', content: user }], thinking: { type: 'adaptive' }, output_config: { effort, format: { type: 'json_schema', schema } }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })`.
    - The output is the first `text` block, parsed as JSON.
  - **`stream({ system, user, effort, signal, onText }): Promise<{ text: string; model: string; stopReason }>`:**
    - It calls `client.beta.messages.stream({...same, no format})`, then
      `.on('text', onText)` and `await .finalMessage()`.
    - On `max_tokens` it returns the partial text with `stopReason`; the
      caller marks it truncated.
  - **`model` in the result** is `message.model`, which shows when a fallback
    answered.
  - **Errors** become `AiError`:
    - there is no key, or the vault is locked: `no-key`, `Add an Anthropic API key in Settings → AI & integrations`;
    - `AuthenticationError`: `auth`, `Anthropic rejected the API key`;
    - `RateLimitError`: `rate-limit`, `Claude is rate-limited; try again in a minute`;
    - `APIConnectionError`: `network`, `Can't reach the Anthropic API`;
    - `APIUserAbortError`: `cancelled`;
    - `stop_reason` `refusal`: `refused`, `Claude declined this request`;
    - other `APIError`: `api`, `Claude API error (HTTP <status>)`.

    Every message goes through `redact(msg, knownSecrets)`.
  - **Type the request** with the SDK's `Beta…Params` types. If 0.131.0's
    types lack `fallbacks` or `output_config.effort`, pass them through the
    SDK's documented extra-body mechanism and note it in a comment, never
    `as any` on the whole call.
- **`AiRequests`** is a registry of `requestId → AbortController`, with
  `cancel(id)`. On a vault lock it cancels everything, because the key may no
  longer be readable.
- **IPC:**
  - `'ai:status': [] → IntegrationStatus['ai']`;
  - `'ai:cancel': [requestId] → void`;
  - event `'ai:delta': { requestId: string; text: string }`.

- [ ] **Step 1: Write the failing tests** (fake factory, except the localhost
  test):
  - `builds the request with model, effort, adaptive thinking and fallbacks`;
  - `uses the configured model`;
  - `no key → no-key error without calling the SDK`;
  - `maps SDK errors to AiError` (one case per typed error, built with the
    SDK's own constructors);
  - `refusal stop_reason → refused`;
  - `stream forwards deltas and returns final text`;
  - `cancel aborts the request`;
  - `a failed call never echoes the key`;
  - `real SDK against a localhost server sends the expected request`:
    - `http.createServer` on `127.0.0.1:0` captures one POST, then the
      factory is the real `Anthropic` with `baseURL` set;
    - it asserts the path `/v1/messages?beta=true` (or whatever 0.131.0 uses;
      assert by inclusion), the `anthropic-beta` header containing
      `server-side-fallback-2026-07-01`, the `model`, and that
      `x-api-key` equals the fake key;
    - the server replies with a canned message JSON.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit**: `feat(ai): Claude client on @anthropic-ai/sdk 0.131.0 with fallbacks, typed errors, cancel`

---

### Task 9: Release notes, from prompt and generation to fallback and finalize

**Files:**
- Create: `src/main/ai/release-notes.ts`.
- Modify: `src/main/notify/finalize.ts` (`releaseNotes`),
  `src/main/ipc/handlers/ai.ts`, `src/shared/ipc.ts`, `src/shared/ai.ts`.
- Test: `tests/main/release-notes.test.ts` (new).

**Interfaces:**
- **`interface ReleaseNotesRequest`:**
  - `{ environmentId: string; productName: string | null; deploymentNames: string[]; version: string | null; commits: CommitInfo[] }`;
  - at most 500 commits (Phase 8 already truncates); a subject is at most
    300 chars. `CommitInfo` has no body.
- **`notesPrompt(req, redaction)` → `{ system, user }`:**
  - **system** (fixed):
    - write release notes for sales and marketing, in plain language;
    - sections in this order: `## Features`, `## Enhancements`, `## Fixes`,
      `## Hotfixes`, omitting empty ones;
    - one bullet per user-visible change, merging duplicates and dropping
      chores, CI and merge commits;
    - no commit hashes, author names or internal ticket noise;
    - Markdown subset only (headings, bullets, bold, inline code);
    - redaction placeholders such as `‹redacted›` are left as they are.
  - **user:** the product, environment name, version, then the commits as
    `- <subject>`, grouped by deployment name when there is more than one.
  - **`author`, `date` and `sha` are never sent.** Subjects pass through
    `redactPromptParts`.
- **`generateNotes(req, { claude, onText?, signal, trigger }): Promise<ReleaseNotesResult>`.**
  `ReleaseNotesResult = { requestId; text; model: string | null; source: 'claude' | 'fallback'; truncated: boolean; redactions; error?: AiError }`.
- **`fallbackNotes(commits): string`.** It is deterministic: it groups by
  conventional prefix (`feat` → Features, `perf`/`refactor`/`enh` →
  Enhancements, `fix` → Fixes, `hotfix` → Hotfixes) and drops `chore`, `ci`,
  `build`, `docs`, `test` and merges. Anything left unknown goes under
  Enhancements.
- **Finalize `releaseNotes(ctx)`:**
  - If `ctx.run.releaseNotes` is non-empty (edited in the dialog), it is kept
    as is.
  - When `ctx.run.redeploy` is true it returns `null` and logs
    `Release notes: skipped (no new commits)`.
  - Otherwise it calls Claude. On any `AiError` it uses `fallbackNotes`, logs
    `Release notes: Claude unavailable (<code>); used commit list`, and
    **never throws**.
- **IPC:** `'ai:releaseNotes': [requestId: string, req: ReleaseNotesRequest] → ReleaseNotesResult`.
  The deltas arrive as `ai:delta` with the same `requestId`.
- Audit: `ai.release_notes`.

- [ ] **Step 1: Write the failing tests:**
  - `prompt orders sections and excludes authors`: a snapshot of `system`
    and `user` for 4 commits; no author or email appears;
  - `commit text is redacted before sending`: a commit subject holding
    `token=abc…` and a known secret;
  - `streams via claude and returns text`;
  - `fallback groups conventional commits deterministically`;
  - `finalize keeps edited notes`;
  - `finalize redeploy → null, no claude call`;
  - `finalize uses fallback when claude errors and never throws`;
  - `audit ai.release_notes has counts but no content`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit**: `feat(ai): Claude release notes with redaction, streaming, deterministic fallback`

---

### Task 10: Release notes editor (renderer)

**Files:**
- Create:
  - `src/renderer/src/ai/stream.ts`;
  - `src/renderer/src/ai/ReleaseNotesEditor.tsx`;
  - `src/renderer/src/ai/NotesPreview.tsx`.
- Modify:
  - `src/renderer/src/ai/register.ts` (new), imported once from `App.tsx`.
    It calls `registerReleaseNotesEditor(ReleaseNotesSlotEditor)` and
    enables the wizard's notify/QA toggles (gap 2 in Upstream interfaces);
  - `pages/deployments/release/ReleaseWizard.tsx`: also render
    `ReleaseNotesSlot` in the *Confirm* step, with `{ releaseId, commits }`
    (gap 1);
  - main: `ReleaseService.setNotes` and the `release:set-notes` channel and
    validator (gap 1);
  - `ReleaseView`: read-only notes with a copy button, from
    `ReleaseDetail.releaseNotes`.
- Test: `tests/renderer/release-notes-editor.test.tsx` (new).

**Interfaces:**
- **`useAiStream()` returns `{ start(run: (requestId) => Promise<T>), text, state: 'idle'|'streaming'|'done'|'error'|'cancelled', error, stop() }`.**
  - It subscribes to `ai:delta` filtered by `requestId`.
  - Deltas batch into one state update per animation frame.
  - `stop` calls `ai:cancel`.
- **`ReleaseNotesSlotEditor`** adapts the slot props to the editor:
  - in *Choose* (no `releaseId` yet) it shows one muted line, "Notes are
    drafted from the commits after preflight";
  - in *Confirm* it flattens `ReleaseDetail.preflight.commits` (or the
    `preflight.done` report) into `CommitInfo[]` and mounts the editor;
  - it saves through `release:set-notes`, debounced by 400 ms and flushed
    before *Start*;
  - it defaults the wizard's QA toggle to `EnvironmentIntegrations.qaOnDeploy`.
- **`<ReleaseNotesEditor commits value onChange context={{ environmentId, productName, deploymentNames, version }} />`.** The feel:
  - **Header:**
    - the commit count as a chip that expands into the commit list;
    - a model badge;
    - a *Generate with Claude* button with a sparkle icon. It turns into
      *Stop* while streaming and *Regenerate* after.
  - **Body:** split *Write | Preview* tabs with an animated underline
    (`layoutId`).
    - While streaming, text flows into the textarea with a soft blinking
      caret.
    - The preview's section headings pop in with a spring stagger as each
      `##` appears.
    - The user can type at any time. Typing during a stream stops it, keeps
      the text, and shows the toast "Stopped — your edits win".
  - **Footer:**
    - `N values redacted`, with a popover listing the kinds;
    - a word count;
    - *Use commit list instead*, which inserts `fallbackNotes` from a pure
      copy in `src/shared/`.
  - **Empty states:** with zero commits the panel shows the empty state
    "Redeploy — no new commits, no notes or notifications". When AI isn't
    configured, a callout links to Settings and the fallback button is the
    primary action.
  - **Reduced motion:** no caret blink, no stagger, no underline slide.

- [ ] **Step 1: Write the failing tests:**
  - `generate streams deltas into the textarea`: mock `ai:releaseNotes`,
    emit `ai:delta` events, and check the text accumulates;
  - `stop keeps partial text and calls ai:cancel`;
  - `typing during a stream stops it and keeps edits`;
  - `preview renders sections from markdown` (via `parseNotes`);
  - `zero commits shows the redeploy empty state and no generate button`;
  - `slot in Choose shows the after-preflight hint; in Confirm mounts the editor with preflight commits`;
  - `edits save through release:set-notes, flushed before Start`;
  - main `release:set-notes is refused unless the release is ready or blocked` (in `tests/main/release-notes.test.ts`);
  - `not configured shows settings link and fallback`;
  - `error shows the AiError message and keeps the text`;
  - `reduced motion renders without caret and transforms`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Reuse `Button`, `Badge`, `TextAreaField`,
  `EmptyState` and `toast`. The notes Markdown file moved into `src/shared/` in
  Task 4, so both sides import it.
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit**: `feat(ai): animated release notes editor with streaming, stop, preview`

---

### Task 11: Explain & fix, end to end

**Files:**
- Create:
  - `src/main/ai/explain.ts`;
  - `src/renderer/src/ai/explain-store.ts`;
  - `src/renderer/src/ai/ExplainPanel.tsx`;
  - `src/renderer/src/ai/CommandCard.tsx`.
- Modify:
  - `src/main/ipc/handlers/ai.ts`, `src/shared/ipc.ts`;
  - `src/main/ssh/sessions.ts`: expose `meta(id)` if it isn't public;
  - `src/renderer/src/pages/terminals/SessionEnded.tsx` (button);
  - `src/renderer/src/pages/tunnels/TunnelCard.tsx` (button on `failed`);
  - `src/renderer/src/ai/register.ts`: `registerFailureAction(ExplainFailureAction)`,
    which renders the button in Phase 8's `FailurePanel` for its `{ releaseId, stepId }`;
  - `src/renderer/src/App.tsx` (mount `ExplainPanel`).
- Test: `tests/main/explain.test.ts` (new),
  `tests/renderer/explain-panel.test.tsx` (new).

**Interfaces:**
- **Main, `explain.ts`.** `buildContext(subject, deps) → { parts: Record<string,string>; target; envBlocks: Set<string> }`
  is built **in main from main's own state**. The renderer sends only ids:
  - **release** (from `ReleaseService.detail` and `events`):
    - the failed step's `STEP_LABEL[kind]`, its `name` and the `step.failed`
      error. Phase 8 events carry no shell command, so none is sent;
    - the last 200 `log` lines whose `stepId` matches, read back through
      `events(id, afterSeq, 5000)` pages;
    - the step's `hostId` from `step.started`, which gives the host label
      and the host OS from the inventory, if known;
    - `composeSnippet(deploymentId)`, which is always `null` in Phase 8, so
      it is left out (the `envBlocks` path is tested with a fake);
    - the environment name and whether it is protected.
  - **session:**
    - the `SessionError` code and message;
    - the hop labels and their order;
    - the auth method kind (`key`/`password`/`agent`) **without** names;
    - the port;
    - the known-host status.
  - **tunnel:**
    - the type, bind address and port (loopback is kept), and the target port;
    - the `TunnelError` code and message;
    - `failures` and `liveness`;
    - the host label.
- **`explain(requestId, subject, { claude, redaction, audit, signal }): Promise<Explanation>`:**
  - the system prompt asks for the cause and fix with copy-pasteable POSIX
    commands, marking `where` and `risk`, and says "never include
    placeholders like ‹redacted› inside commands unless the user must fill
    them; say so in the title";
  - it uses `claude.complete` with `EXPLANATION_SCHEMA` and `effort: 'high'`,
    then `parseExplanation`;
  - it audits `ai.explain`.
- **IPC:** `'ai:explain': [requestId, subject: ExplainSubject] → Explanation`
  and `'ai:command': [requestId, index, mode: 'copy' | 'run'] → void`, which
  audits `ai.command`.
  - Main keeps the last 20 explanations in memory, so `ai:command` reads the
    command text from main's copy and **not** from the renderer. The audit
    reflects what Claude actually suggested.
- **Renderer:**
  - `explainStore` holds `{ open; subject; state: 'loading'|'ready'|'error'; explanation; error }`
    and `explain(subject)`.
  - **`<ExplainPanel>`** is a right-side drawer that slides in on a spring.
    - **While loading:** a shimmer skeleton with rotating phrases ("Reading
      the last 200 log lines…", "Redacting secrets…", "Asking Claude…") and a
      *Cancel* button.
    - **Ready:** a confidence pill, the summary (large), a collapsible
      **Cause**, and numbered **Fix steps** that check off when clicked (local
      state only).
    - **Commands:** one `CommandCard` each, with mono text, the `where` badge
      (host label or `local`), a `risk` badge (red for `destructive`), and
      **Copy** (a check-morph animation, then `ai:command copy`) and **Run in
      terminal**.
    - **Footer:** a *Sent to Claude* disclosure (`sentContext`, the redaction
      counts, the model, "server-side fallback on").
    - Esc closes the panel, and focus returns to the trigger.
  - **Run in terminal:**
    1. It opens `ConfirmDialog`:
       - title `Run on <host label>?`, or `Run locally?`;
       - a description showing the exact command in a mono block;
       - `typeToConfirm: environmentName` when `target.protected`;
       - `confirmLabel` `Run` or `Run destructive command`.
    2. `run()`:
       - calls `openSsh(hostId, environmentId)` for `where: 'host'`, or
         `openLocal()`;
       - waits for the session store to show `ready` (timeout 30 s, toast on
         failure);
       - calls `session:write(id, command + '\r')`;
       - calls `ai:command run`;
       - switches to the terminal tab.
    - **Nothing else writes AI text to a session.**
  - **Entry points:**
    - `Explain` buttons with a sparkle icon on `SessionEnded` (ssh with error),
      `TunnelCard` (state `failed`) and the Phase 8 `FailurePanel`;
    - the palette's `Explain last failure`.
    - Each button is disabled with a tooltip when AI isn't configured.

- [ ] **Step 1: Write the failing tests**
  - `explain.test.ts`:
    - `release context has step, last 200 lines of that step only, redacted`: 300
      log lines in, 200 out; a vault value and an IP in the log come out
      redacted;
    - `session context never includes usernames or key names`;
    - `tunnel context keeps loopback, redacts target host`;
    - `parses structured output and caps commands`;
    - `bad output → bad-output error`;
    - `ai:command reads the command from main's copy and audits it redacted`;
    - `audit ai.explain has no content`.
  - `explain-panel.test.tsx`:
    - `opening the panel never touches a session`: no `session:write` or
      `ssh:open` invoke;
    - `copy writes clipboard and audits`;
    - `run in terminal writes only after confirm`: there is no write before
      confirm, then exactly one `session:write` with `command + '\r'` after
      the session is `ready`;
    - `protected environment requires the typed name`: Run stays disabled
      until the name is typed;
    - `cancel writes nothing`;
    - `destructive command shows red badge and confirm label`;
    - `loading shows skeleton and cancel calls ai:cancel`;
    - `reduced motion: no slide, no shimmer`;
    - `TunnelCard failed shows Explain; disabled when AI not configured`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit**: `feat(ai): Explain & fix with redacted context, structured answer, confirmed run-in-terminal`

---

### Task 12: Settings page, environment notifications, palette, roadmap

**Files:**
- Create:
  - `src/renderer/src/pages/settings/IntegrationsPage.tsx`;
  - `src/renderer/src/pages/products/EnvironmentNotifications.tsx`;
  - `src/renderer/src/settings/commands.ts`;
  - `src/renderer/src/settings/store.ts`.
- Modify:
  - `src/renderer/src/pages/products/EnvironmentDialog.tsx`;
  - the router and `shell/sections.ts`: add a `/settings` route reached from
    the sidebar footer gear and the palette, without a new section slot;
  - `src/renderer/src/App.tsx` (the `app:navigate` listener and the
    `notify:sent` toasts);
  - `docs/superpowers/plans/2026-10-16-roadmap.md`.
- Test: `tests/renderer/integrations-page.test.tsx` (new),
  `tests/renderer/environment-notifications.test.tsx` (new).

**Interfaces:**
- **`IntegrationsPage`** has four cards that stagger in. Each card has a
  status dot: green when configured, grey when not.
  - **AI:**
    - a model field (default shown with a *Reset* link);
    - an API key picker. It is a `SelectField` of `api_key` secrets, plus
      *New key…*, which opens an inline `SecretField` and creates the secret
      through the existing `secret:create`. The value goes straight to the
      vault and is never shown again.
  - **SendGrid:** the key picker and the from address, plus *Send test
    email…* (pick an environment).
  - **GitHub:** the token picker.
  - **macOS:** the enable and unscoped switches, plus *Send test
    notification*.
  - Saving uses `attempt(settings:update)`.
- **`EnvironmentNotifications`** is a section inside `EnvironmentDialog`:
  - the event chips (`NOTIFY_EVENTS`, toggle);
  - the Teams webhook picker (`webhook` secrets, plus *New webhook…*);
  - *Send test card*;
  - the email to/cc token inputs (validated, max 20);
  - the QA repo, workflow, ref, *Run QA after deploy* (prefilled off for
    prod-like names, with a hint saying why) and *Wait for result*;
  - a recent `notify:log` list for this environment, with status dots.
- **Palette:** `Settings: AI & integrations`, `Send test Teams message to <env>`
  and `Run QA for <env>`.
- **Toasts:** `notify:sent` with status `failed` shows an error toast,
  `Teams notification to <env> failed`, with a *View* action that opens the log.
  Successes are quiet: no toast, and `ReleaseView` shows the per-channel log lines in the finalize steps.
- **Roadmap row 9:** `done (branch phase9-notify-ai)` when merged; until
  then, `planned`.

- [ ] **Step 1: Write the failing tests:**
  - `shows configured state per card`;
  - `new API key creates a secret and selects it; value never rendered back`;
  - `model validation error inline`;
  - `test notification calls notify:test`;
  - `environment notifications round-trip events, recipients and QA`;
  - `prod environment hints QA off by default`;
  - `invalid email shows inline error`;
  - `palette registers settings and per-env test commands`;
  - `app:navigate routes`;
  - `failed notify:sent shows error toast`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Update roadmap row 9.
- [ ] **Step 4: Run the full suite and typecheck.**
- [ ] **Step 5: Commit**: `feat(settings): integrations page, environment notifications, palette; roadmap row 9`

---

## Self-review notes

- **Spec coverage:**
  - **G14 / §8.6:**
    - T2 is the redaction;
    - T8 is the client;
    - T11 builds the context from the step, 200 log lines, OS and compose
      snippet, and renders the cause, steps and commands with copy and run;
    - audit records the request, not the content (T11).
  - **G15 / §8.7:**
    - T3 is Teams;
    - T5 is macOS;
    - T6 does the per-environment events, and T12 is their UI;
    - "tunnel dropped and not recovered" is `failed` with `wasUp` (T6);
    - messages hold only the §8.7 fields (T3 test `card never contains
      addresses or log text`).
  - **§8.4 Finalize:**
    - notes in T9 and T10 (the order features → enhancements → fixes →
      hotfixes, written for sales and marketing);
    - Teams and email in T6 and T4;
    - QA in T7 (skipped on prod-like environments by default, plus the wait
      and notify);
    - the 0-commit redeploy in T6 and T9.
  - **§6:**
    - default model `claude-opus-5-5`, configurable (T1, T12);
    - the key lives in the vault (T1);
    - the webhook is a vault secret (T1).
  - **§7:** every listed Environment, Release and Settings field is covered;
    `notification_log` and `qa_wait` are justified additions.
  - **§9a:** the prompt intent matches `release_mail.sh` (T9); the audit actor
    is unchanged.
  - **§5:**
    - no secrets in Teams or AI: Review Focus 1;
    - AI never runs a command by itself: Review Focus 4;
    - nothing is lost: the fallback notes, plus failures that never fail the
      run (Review Focus 5);
    - no animation blocks input (T10, typing during a stream).
- **Constraints from the brief:**
  - The vault holds every credential, read only in main.
  - The redaction covers env values, tokens, passwords, keys, IPs and
    usernames.
  - AI is never auto-executed, and a protected environment needs the typed
    name.
  - The SDK is pinned exactly at 0.131.0, the model is configurable, and
    server-side fallbacks are on.
  - Tests use no network: everything is stubbed, except one localhost server.
  - User actions are audited.
- **Types:**
  - The `settings.ts` and `ai.ts` types are defined in T1 and used unchanged
    after that.
  - `NotificationFacts` is defined in T3 and used by T4–T7.
  - `NotificationSink` is defined in T5 and used by T6 and T7.
  - `ClaudeClient` is defined in T8 and used by T9 and T11.
  - `ReleaseNotesRequest` and `ReleaseNotesResult` are defined in T9 and used
    in T10.
  - `Explanation` and `ExplainSubject` are defined in T1 and used in T11.
- **Deferred:**
  - Sending from the Hub, with shared Teams, SendGrid and GitHub tokens
    (Phase 10 swaps the `NotificationSink`).
  - Re-sending a past release's notification.
  - Notification rules per deployment rather than per environment.
  - Slack.
  - Explain from the Phase 6 map (it can call `explainStore.explain` with a
    tunnel subject; one line, if the controller wants it).
  - A dedicated eval set for the Explain prompts.
