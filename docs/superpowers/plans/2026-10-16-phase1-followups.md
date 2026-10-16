# Phase 1 follow-ups

Open items from the Phase 1 task reviews and the final review. They were
deferred on purpose. Each later phase plan picks up the items in its area.

## Phase 2 (first task)
- Electron fuses: RunAsNode off, NodeOptions env var off, `--inspect` CLI args
  off, OnlyLoadAppFromAsar + asar integrity on (electron-builder `electronFuses`).
  Verify with a packaged launch.
- CSP: add `object-src 'none'` and `base-uri 'none'`.
- Bigint in audit details: decide on stringifying it (redact passes bigint through).
- `audit.list` can return a corrupt row's raw details unredacted (`{_corrupt: raw}`).
  Run the raw string through `redact` before returning it.

## IPC (whenever channels are added)
- The IPC boundary doesn't check argument shapes. Add per-channel validators
  (an `asFilter` guard for audit filters).
- `registerHandlers` passes extra renderer arguments through. Truncate them to each
  channel's arity.
- Missing tests: null `senderFrame`, a traversal `file://` URL, `file://host/...`,
  and the verify failure details.

## Audit
- Deleting the tail row can't be detected. Anchor the head hash and count
  somewhere outside the table.
- `verifyChain` loads every row. Switch to iterating.
- LIKE search is case-insensitive for ASCII only.
- Every `audit:verify` call appends an event (ruling-mandated). Watch log growth.

## Redaction
- An own `__proto__` key is dropped. Use `Object.create(null)` or `defineProperty`.
- Masked keys can collide. Symbol and non-enumerable keys are dropped.
- The key regex is broad: `compass`, `bypass` and `maxTokens` are over-redacted
  (plan-mandated).

## DB
- `openDatabase` doesn't close the handle if `migrate` or a pragma throws.
- The migration `from` version is read before BEGIN IMMEDIATE. This is moot under
  the single-instance lock.

## Renderer / UX
- `mod+1..6` don't fire while focus is in a textarea. Revisit with xterm in Phase 4.
- `markRecent` drops recents for commands that aren't registered right now. Revisit
  if commands become route-scoped.
- Clicking a palette group header or the scrollbar can blur the input, so Esc
  stops working. Fix: preventDefault on the list container.
- When 4 error toasts are visible, a new info toast is evicted immediately.
- Export uses the debounced search text, which can be up to 250 ms stale.
- The audit drawer has no focus trap and covers the Target column.
- A reload after verify or export drops pages already loaded with "Load more".
- `tests/renderer/api.test.ts` doesn't restore `window.opsdeck`.

## Packaging
- No app icon. The build targets arm64 only. The app is unsigned (Gatekeeper
  needs right-click → Open).
- The window test doesn't assert size, show or title.
