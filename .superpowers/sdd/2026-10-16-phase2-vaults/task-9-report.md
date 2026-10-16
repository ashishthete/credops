# Task 9 report: renderer lock flow

Commit: 8de78b9 feat: vault setup, unlock dialog, lock button and settings (BASE 6efdc6b)

## What I implemented
- `ui/Dialog.tsx`: the `Dialog` from the brief (open, onClose, title, description, children, footer). It has a focus trap (Tab and Shift+Tab wrap), and Esc closes it; the Esc handler sits on the panel and calls stopPropagation, so stacked dialogs close one at a time. Focus goes back to the opener when `open` turns false. The card springs in from scale 0.96 over a blurred backdrop, and a click on the backdrop closes it. I added three optional props: `icon`, `width`, and `shake` (a counter; each bump runs x `[0,-8,8,-5,5,0]` over 250 ms, skipped under reduced motion).
- `ui/Field.tsx`: `TextField`, `SecretField`, `SelectField` and `TextAreaField`. Each takes label, error?, an extra `hint?` and native props, with ref passed as a prop (React 19). `SecretField` has an eye toggle and sets autoComplete=off, spellCheck=false, autoCapitalize/autoCorrect off and a mono font. Messages use aria-describedby and aria-live, inputs get aria-invalid, and the message element is keyed by its text. That way a hint that becomes the same error just changes colour.
- `ui/Padlock.tsx` (extra file, not in the brief's list): an SVG padlock whose shackle springs up and swings 14° on `open`. The dialog badge and the sidebar button both use it, so it lives in `ui/`.
- `vault/strength.ts`: one point each for length 10, 14 and 20, plus one for using 3 character classes and one more for all 4. The result is capped at 4, and anything under MIN_MASTER_PASSWORD scores 0 (P5). Scores: 'short' 0, 'correct horse' 1, 'c0rrect-Horse-battery-staple' 4.
- `vault/status.ts`: `vaultStatusStore`, `refreshVaultStatus()` and `useVaultStatus()`. Polling is shared by reference count: the first subscriber fetches at once, then every 5 s and on window `focus`; the last unmount stops it. A failed poll keeps the last status.
- `vault/unlock.ts`:
  - `ensureUnlocked()` returns at once if the cached status says unlocked. Otherwise it refreshes, and if still locked it queues the caller. All callers share one prompt.
  - `resolveUnlock` and `cancelUnlock` settle every waiter.
  - `withUnlock(fn)` retries once on `VAULT_LOCKED`, after a refresh, and resolves undefined if the user dismisses the prompt. Other errors are rethrown.
  - `lockVaults()` locks, shows "Vaults locked" and refreshes.
  - `takeUserLock()` keeps a lock the user asked for from being announced twice.
- `vault/UnlockDialog.tsx` (mounted once in App):
  - Shows `SetupCard` when the vaults are not set up, otherwise the unlock form. The form is remounted for each prompt.
  - The password is uncontrolled. State holds only `hasInput`. The value is read and the field cleared at submit, and focus stays in the input: it is readOnly while busy, not disabled.
  - A wrong password shows "Wrong password" and shakes the card. A throttled result shows "Try again in N s", with a 250 ms tick, a drain bar and the button disabled; the countdown also starts from `status.retryAfterMs` when the dialog opens.
  - Quick unlock is tried once automatically on open when the mode is not off and is available; the "Unlock with Touch ID" button appears in touchId mode only. 'unavailable' hides the button and shows a short hint under the field. 'cancelled' shows nothing.
  - On success: status refresh, the waiters resolve right away, then the toast "Vaults unlocked". If `corruptVaultIds` is non-empty, a warn toast "N vault(s) could not be opened" follows. The padlock springs open and a green ring flashes, held for 360 ms (0 under reduced motion).
  - `useLockWatcher` covers locks seen by polling: an unlocked → locked change the user did not ask for shows "Vaults locked" ("Locked automatically…", with an Unlock action).
  - It also exports `useSecondsLeft`.
- `vault/SetupCard.tsx`:
  - Master password plus confirm, with "At least 10 characters" (a hint that turns into an error), "Passwords don't match" and the "Create master password" button.
  - `StrengthMeter` has 4 segments that fill with a spring, tinted err, then warn, then ok, with a label. The meter is exported and reused in settings.
  - After setup a success toast offers "Enable Touch ID" when Touch ID is available and quick unlock is off.
  - Inputs are uncontrolled; state holds only lengths and the match flag.
- `vault/VaultSettingsDialog.tsx`:
  - `openVaultSettings` and `closeVaultSettings`.
  - "Quick unlock" select: Off, plus each available mode, plus the current mode if it has since become unavailable. Changes go through `withUnlock`.
  - "Auto-lock" select: 1 min, 5 min, 15 min, 1 hour or Never; Never calls `setAutoLock(null)`. This works while locked (P9).
  - Change-password form (current, new with meter, confirm) through `withUnlock`. "Wrong password" shakes the dialog, throttling shows a countdown, and the fields clear after each attempt.
- `shell/VaultLockButton.tsx`, placed in the Sidebar above the actor footer:
  - The padlock button's name tracks the state: "Lock vaults", "Unlock vaults" or "Set up vaults" ("Vaults", disabled, while loading). It is tinted green when unlocked and shows ⌘L on hover; there is a gear for Vault settings next to it.
  - It registers the palette commands "Lock vaults" (mod+l) or "Unlock vaults", plus "Vault settings…", re-registering only when loaded, setUp or unlocked changes.
  - `mod+l` locks only while unlocked.
- `App.tsx` mounts `<VaultSettingsDialog/>` and then `<UnlockDialog/>`, so the unlock prompt stacks above settings.
- `tests/renderer/helpers.tsx`: `vaultStatus(over)` (set up, locked, mode off, auto-lock 15, Touch ID available), `defaultVault`, and default mock answers for vault:status, vault:list, secret:list, key:list and identity:list.

## Tests
`tests/renderer/vault-lock.test.tsx` has 20 tests:
- every case in the brief: setup validation and submit, strength meter, unlock dialog, Esc, throttle countdown with fake timers, Touch ID (auto-try once, then the button; not called when off), withUnlock retries once, sidebar lock button, Meta+L, status polling, settings;
- extra cases: setup toast with Enable Touch ID; already unlocked resolves at once; corrupt-vault warn toast; throttled result starts a countdown; 'unavailable' falls back to the password with a hint; withUnlock dismissed resolves undefined and rethrows other errors; refresh on window focus; a quick-unlock change calls setQuickUnlock;
- the unlock test also checks the password text never appears in the DOM.

### TDD evidence
- RED: `pnpm test tests/renderer/vault-lock.test.tsx` failed with `Error: Failed to resolve import "../../src/renderer/src/vault/SetupCard"`, "Test Files 1 failed, Tests no tests". That was expected: none of the modules existed yet.
- GREEN: `pnpm test tests/renderer/vault-lock.test.tsx` gave "Tests 20 passed (20)".
- Full suite: `pnpm test` gave "Test Files 20 passed (20), Tests 212 passed (212)", with no warnings or act() noise in renderer output. `pnpm typecheck` was clean (tsconfig.web includes tests/renderer), and `pnpm build` succeeded.

During GREEN I fixed two of my own test mistakes. A misplaced assertion had landed in the wrong test, and the withUnlock test had started the fake vault as unlocked, so the dialog never appeared. Two assertions now wait for the field-message exit animation.

## Files
New:
- src/renderer/src/ui/{Dialog,Field,Padlock}.tsx
- src/renderer/src/vault/{status,unlock,strength}.ts
- src/renderer/src/vault/{UnlockDialog,SetupCard,VaultSettingsDialog}.tsx
- src/renderer/src/shell/VaultLockButton.tsx
- tests/renderer/vault-lock.test.tsx

Modified: src/renderer/src/App.tsx, src/renderer/src/shell/Sidebar.tsx, tests/renderer/helpers.tsx

## Self-review findings (fixed)
- Commands were re-registered on every 5 s poll, because the deps held the status object, which caused palette churn. Deps are now the booleans.
- The button read "Set up vaults" while status was still loading. It now reads "Vaults" and is disabled.
- In lockVaults, a failed refresh after a successful lock reported "Couldn't lock". The refresh failure now just sets the cached status to locked.

## Concerns / notes
- There is no push lock event in main. The lead's note said "the lock event to the renderer" had landed, but the preload exposes only `invoke` and nothing calls `webContents.send` for lock. Auto-locks are seen through the 5 s poll plus the focus refresh, which is what the brief specifies, so the renderer can lag a real lock by up to 5 s. withUnlock covers any action taken in that window.
- First-run: the unlock dialog does not open setup by itself at launch. Task 10's test renders the page's `SetupCard` alongside `<UnlockDialog/>`, and an auto-opened setup dialog would put two "Create master password" buttons on screen. Until Task 10, setup is reachable from the sidebar "Set up vaults" button or the palette.
- I did not check the animations by hand in the running app. jsdom does not run them, so the motion is verified only by reading the code.
- Interface additions beyond the brief: Dialog `icon`, `shake` and `width`; Field `hint`; exports `StrengthMeter`, `useSecondsLeft`, `lockVaults`, `cancelUnlock`, `resolveUnlock`, `unlockRequestStore`, `takeUserLock`, `openVaultSettings` and `closeVaultSettings`. Padlock is an extra file.
- The quick-unlock select also lists the current mode if it has become unavailable, so the select never shows a value it doesn't offer. In the brief's test fixture only the available modes are offered.

## Amendment 1 (team-lead): full-app auth gate, Touch ID only

Changes
- New `src/renderer/src/vault/AuthGate.tsx`: App wraps AppShell + CommandPalette + VaultSettingsDialog in `<AuthGate>`. While status is null, not set up, or locked, only a full-screen gate is mounted (drag strip, centered card): a padlock splash while loading, `SetupCard` on first run, the unlock card otherwise. Unlock -> padlock springs open (360 ms, 0 under reduced motion) -> gate blurs/scales out, shell fades/scales in. Any lock (manual, mod+l, auto-lock, screen, sleep — all seen via status polling/focus) unmounts the shell at once and brings the gate back; palette and settings are closed.
- After setup a "Your vaults are ready" step offers "Enable Touch ID" (when available and mode off) or "Continue"; the shell mounts after the choice. The setup toast moved into this step.
- `UnlockDialog.tsx` renamed to `UnlockCard.tsx`: exports `UnlockCard` (the former form, reused, not duplicated), `LockBadge`, `useSecondsLeft`. The dialog wrapper and request store are gone.
- Touch ID is the only quick path: the card auto-prompts once per lock when mode is touchId, offers "Unlock with Touch ID", password always the fallback. `login` mode is never honoured by the gate and never offered in settings (only shown if already current). Backend unchanged.
- A user-initiated lock does not auto-pop Touch ID (they are walking away); the button is still offered. Auto-locks do auto-prompt. Lock detection is derived during render, because the fresh card's mount effect runs before parent effects.
- `ensureUnlocked`/`withUnlock` kept: a locked status already shows the gate; waiters resolve when the gate is passed (`resolveUnlock`); `cancelUnlock` resolves them false. If status can't be read, `ensureUnlocked` resolves false instead of waiting.
- `useShake` hook extracted to `ui/motion.ts` (Dialog and gate share it).

Tests (tests/renderer/vault-lock.test.tsx, 23): rendered through the real `<AuthGate>` composition. New: shell not mounted while locked (and only vault:status was invoked); locking unmounts the shell; first run gates setup then the Touch ID offer; manual lock doesn't pop Touch ID; login mode is ignored by the gate; settings select offers only off/touchId.

Command: `pnpm typecheck && pnpm test && pnpm build`
Output: typecheck clean; Test Files 20 passed, Tests 215 passed; build ok.

Concerns
- Task 10: the vaults page can no longer be reached when not set up, so its "SetupCard when !setUp" case is moot; its tests should render through `<AuthGate>` (or assume unlocked) instead of `<UnlockDialog/>`, which no longer exists.
- A VAULT_LOCKED mid-session unmounts the calling page; `withUnlock` still retries after unlock, but any component state of the caller is lost.
- Locks are detected by polling (5 s) + window focus, since main pushes no lock event; the shell can stay visible up to 5 s after an auto/screen lock while the window is focused. A push event from main would close that gap.
