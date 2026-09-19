---
compass_area: "companion: the phone page's loopback listener, Sessions verbs, Push, and terminal mirror"
area_path: "src/main/companion/"
generated: "2026-09-18"
# Staleness stamp, machine-readable so a refresh can test drift without a model.
# `sources` are area-relative paths (relative to THIS file's directory). Recompute:
#   node ~/.claude/skills/project-compass/compass-hash.mjs src/main/companion/COMPASS.md
sources_hash: "sha256-16:8c48367945bf718e"
sources:
  - companion-owner.ts
  - companion-sessions.ts
  - companion-page-mirror.ts
  - companion-mirror-target.ts
  - companion-api-routes.ts
  - companion-server.ts
  - companion-http.ts
  - companion-assets.ts
  - companion-auth.ts
  - companion-router.ts
  - companion-rows.ts
  - companion-listener.ts
  - companion-settings.ts
  - companion-config-store.ts
  - companion-pairing.ts
  - away-push.ts
  - push-describe.ts
  - push-sink.ts
  - ../pty/pty-mirror-lease.ts
  - ../terminal/mirror-input-notice.ts
  - ../../shared/sessions-companion.ts
  - ../../shared/companion-settings.ts
  - ../../shared/actionable-attention.ts
  - ../../shared/terminal-wheel.ts
  - ../../renderer/companion/index.html
  - ../../renderer/companion/src/companion-terminal-pane.ts
  - ../../renderer/companion/src/ghostty-companion-pane.ts
  - ../../renderer/companion/src/companion-terminal-mount.ts
  - ../../renderer/companion/src/companion-mirror-feed.ts
  - ../../renderer/companion/src/companion-mirror-scroll.ts
  - ../../renderer/companion/src/companion-mirror-zoom.ts
  - ../../renderer/companion/src/companion-input-arming.ts
  - ../../renderer/companion/src/use-input-arming.ts
  - ../../renderer/companion/src/use-companion-session.ts
  - ../../renderer/companion/src/companion-store.ts
  - ../../renderer/companion/src/terminal-view.tsx
  - ../../renderer/companion/src/mirror-header.tsx
  - ../../renderer/companion/src/mirror-controls.tsx
  - ../../renderer/src/terminal/use-terminal-attention-controller.ts
---

# Compass: companion, the phone page's loopback listener, Sessions verbs, Push, and terminal mirror

> Tribal-knowledge map for `src/main/companion/` and the phone page under
> `src/renderer/companion/` that it serves. The *why* and the *gotchas*, not the *what*.
> Canonical decisions: `docs/adr/ADR-049-companion-observer-and-away-push.md`,
> `docs/adr/ADR-050-companion-live-terminal-mirror.md`, and
> `docs/adr/ADR-051-terminal-notification-prompt-attention.md`. Operator view:
> `docs/runbooks/companion-operator.md`.

## Purpose

The Companion is the one network listener hvir owns (ADR-049 carves it out of ADR-010's
prohibition): a `node:http` server bound to `127.0.0.1` only, serving a second Vite entry as a
phone-sized page and a small `/api` behind a paired bearer credential. The page reads the same
Sessions projection the desktop reads, answers external sessions through the same transcript
port, and, under ADR-050, mirrors one live hvir-owned terminal per page and carries the user's
keystrokes back to it. Away-time Push rides the same actionable set that drives the OS badge.
Nothing here is a second session authority: every lease is a companion demand owner the
Sessions ports already understand, and every PTY byte enters and leaves through the PTY
supervisor's doors.

## Key files & entry points

- **`companion-owner.ts`**: the composition root on `WorkbenchRuntime`. Declares
  `CompanionDependencies` (the ports `src/main/index.ts` injects, including
  `mirrors: Pick<PtySupervisor, 'attachMirror'>`), builds settings, the sessions service, the
  server, the `/api` routes, `AwayPush`, and the listener that follows Settings. Wind-down
  order is the order a phone notices: Push stops, every page hears `shutdown`, the listener
  closes, the settings file flushes. Revocation runs `sessions.closeAll('revoked')`.
- **`companion-sessions.ts`**: page lifecycle. One observation lease per page under
  `{ kind: 'companion', page, generation }`, at most one transcript lease, and one
  `CompanionPageMirror`. Registers the single companion sink and routes each change to the
  page whose owner and generation it names.
- **`companion-page-mirror.ts`**: the mirror lease owner. One per page, at most one lease at
  a time, ends exactly once with a reason.
- **`companion-mirror-target.ts`**: pure eligibility and identity. Live lifecycle, connected
  host, live PTY, workspace neither closed nor missing: the desktop's Interact gate verbatim.
  Row handle is the PTY `id`; `livePty.handle` is the PTY `instanceId`; both are plain casts.
- **`companion-api-routes.ts`**: `bindCompanionApi`. The SSE stream per page, the Sessions
  verbs, `POST /api/sessions/:handle/input`, and the error-to-status translation.
- **`companion-server.ts`**, **`companion-router.ts`**, **`companion-http.ts`**: transport.
  32 sockets, a closed route table, 64 KiB bodies, `SseWriter` with a 25 s heartbeat and a
  `backlog` getter over `writableLength`.
- **`companion-assets.ts`**: the asset allowlist. The only `CONTENT_TYPES` map; the reader
  serves `companion/index.html` and flat `assets/<name>` files whose extension it names.
- **`companion-rows.ts`**: the join of observation sessions with the actionable set into
  `CompanionRow`. Deliberately drops `livePty`, host id, and the workspace qualifier; exposes
  `canMirror` and `canAnswer` as booleans instead. `promptBodyOf` copies the entry's `body`
  onto the row only when the row's attention is an available `prompt`. `working` is a boolean
  from the same set's `working` handles: what a window shows working, which the renderer sends
  beside its entries in `app:attention` and `ActionableAttentionSet` merges across windows
  (an entry for a terminal outranks working). It is never actionable and never pushes.
- **`companion-settings.ts`**, **`companion-config-store.ts`**, **`companion-pairing.ts`**:
  `companion.json` (version 1), the pairing code and credential, `typingAllowed()` read
  straight from the store.
- **`away-push.ts`**, **`push-describe.ts`**, **`push-sink.ts`**: one Push per row entering
  the actionable set while Away; body is project and title, plus at most one line: an
  external session's first prompt line, or a terminal prompt entry's `body` (ADR-051). The
  sink's `title` header is the entry's kind (`ready`, `bell`, `prompt`).
- Phone page (`src/renderer/companion/src/`): `use-companion-session.ts` holds the one stream
  and every verb; `sessions-list.tsx` shows the rows under one heading per workspace, grouped
  by `companion-row-groups.ts` (groups in name order, rows in the desktop's order within);
  `companion-mirror-feed.ts` is the page's bounded copy of the mirror stream;
  `terminal-view.tsx` is the fixed column (`mirror-header.tsx`, the terminal area,
  `mirror-controls.tsx`); `companion-terminal-mount.ts` builds the pane at the desktop
  geometry and scales it by `companion-mirror-zoom.ts`; `companion-mirror-scroll.ts` turns a
  touch drag over the host into rows; `ghostty-companion-pane.ts` is the only file that
  imports ghostty-web; `use-input-arming.ts` and `companion-input-arming.ts` are the arming
  state.

## How it connects

- **Injected from `src/main/index.ts`** with `sessions: { ...sessionsPorts, sinks }`,
  `actionable: attention.set`, `mirrors: ptySupervisor`, the asset reader over the built
  renderer root, and `onDiagnostic` to `console.warn('[companion]', ...)`. The same root
  installs `terminal/mirror-input-notice.ts`, which forwards `PtySupervisor.onMirrorInput`
  to the owning renderer as `pty:mirror-input` through `RendererEventPublisher.toRenderer`.
- **Downstream:** `sessions/sessions-observation-port.ts` (leases, snapshot, external
  resolution), `sessions/sessions-transcript-port.ts`, `sessions/sessions-companion-sinks.ts`
  (one sink per app), `attention/actionable-attention-set.ts`, and the PTY supervisor's
  `attachMirror` door, which bypasses the renderer owner gate and checks `(id, instanceId)`.
- **Wire contracts** live in `src/shared/sessions-companion.ts` (`CompanionEvent`,
  `CompanionTerminalEvent`, `CompanionMirrorEndReason`, the exact-key guards, the 256K tail
  and 4096-character input bounds) and `src/shared/companion-settings.ts`. Both are
  ownership-guarded: no imports from `./ipc`, `electron`, main, or preload. The attention
  kinds and the prompt message bound come from `src/shared/actionable-attention.ts`:
  `ActionableKind = 'ready' | 'bell' | 'prompt'` and `MAX_ACTIONABLE_BODY_CHARS = 120`.
  `actionableAttentionBody` cuts a notification to its first line, blanks control characters,
  trims, and slices to the bound; `isActionableAttentionBody` admits only a non-empty string
  within it. The renderer applies the cut once, in the pane event coordinator, and every
  later boundary (main's set, the Sessions row, `CompanionRow`, the Push line) validates
  rather than re-cuts.
- **Boundaries crossed:** loopback HTTP and SSE to a browser on another device, the renderer
  through `pty:mirror-input`, and the OS keychain through `safeStorage` for the Push token.

## The mirror lease lifecycle

`CompanionPageMirror` is the lease owner. `select(pageId, handle)` in the sessions service
acquires the transcript lease exactly as before, then resolves `companionMirrorTarget` from the
page's observation snapshot: a target opens a mirror, no target ends any open one with
`reselected`. `open` first ends the current mirror (`reselected`), then calls the supervisor's
`attachMirror(ptyId, instanceId, handlers)`. A `PtyMirrorRefusedError` there means the
instance is already gone, so the page hears `ended exited` and never `opened`; a success emits
`opened { cols, rows, tail }` with the supervisor's retained tail and last applied geometry,
then `output` and `geometry` frames as the handlers fire.

The lease ends on exactly these paths, each mapped to a `CompanionMirrorEndReason` the page
turns into one sentence: the PTY exits or the supervisor releases it (`onEnd` delivers
`exited` or `released`), the page selects another row (`reselected`), the SSE stream cannot
drain output (`overrun`, from the route), the page's socket closes (`page-closed` in
`releaseLeases`), pairing is revoked or hvir shuts down (`revoked`, `shutdown`, through
`closeAll`), or the observation lease is lost (`lease-lost`, in `publish`). `end` is
idempotent, releases the lease before emitting `ended`, and is safe from inside the lease's own
`onData`. `close` ends the mirror before emitting `closed`, so a stream always sees
`terminal ended` before `closed`.

The lease is bound to the PTY instance, never to the renderer owner or generation, so a desktop
document reload leaves it attached. `CompanionPage.mirror` is constructed once per page; there
is no mirror without a page, and `closePage` is the only path that drops both.

## The input path and its gates

`POST /api/sessions/:handle/input` with body exactly `{ page, data }` (`isCompanionInputRequest`:
1 to 4096 characters). Refusal order in `translate`: 404 page not open, 403
`CompanionTypingDisallowedError` (`typingAllowed()` false), 409 `CompanionNoMirrorError` (the
page holds no live mirror for `:handle`) or `CompanionMirrorEndedError` (the lease refused the
write; the mirror is ended with `exited` first), then 200 `{ outcome: 'accepted' }`. The
service checks the Settings permission before it looks at the mirror, so a page with typing
off learns that and nothing else.

A successful write goes `lease.write` to `PtySessionLifetime.write` to `pty.write`, then
`observation.retryAfterInput`, then the supervisor's `onMirrorInput` fan-out, which
`mirror-input-notice.ts` turns into `pty:mirror-input` to the current renderer owner. The
renderer's `TerminalRuntime` hands it to `onMirrorInput`, and the owner of what happens next is
`recordMirrorInput` in `src/renderer/src/terminal/use-terminal-attention-controller.ts`: it
records the bytes as input, so ADR-019 arming stays there, and it clears the session's
attention only when that attention is `prompt` (ADR-051), dropping `promptBody` with it. Ready
and Bell survive phone input untouched; nothing in main classifies or clears. The notice is
generation-gated by `toRenderer`, so an input that lands during a renderer document swap arms
nothing and clears nothing; that is documented in the runbook rather than worked around.

The phone gates before the network: `useInputArming` reports `armed` only while its arming was
made for the mirror that is live now, and `input` in `use-companion-session.ts` drops data
while disarmed. The pane gates the same way for bytes it makes itself: the wheel policy's page
keys and SGR reports go through `emitUser`, which sends nothing while disarmed or while the
pane is writing. A 403 disarms and names Settings; a 409 names the ended terminal.

## Gotchas & non-obvious constraints

- **Mirror bytes are never in a message.** No `console.*`, diagnostic, thrown `Error`, push
  body, or smoke failure carries `data`. `PtyMirrorRefusedError` carries a PTY id and a
  reason; the service errors carry fixed sentences; `request-failure` diagnostics truncate the
  error message to 1000 characters but a route never lets bytes into one. The
  `CompanionOwnerDiagnostic` union has no variant with a data field; keep it that way.
- **The asset allowlist is one map.** `CONTENT_TYPES` in `companion-assets.ts` is the only
  content-type table (the duplicate that lived in `companion-http.ts` was deleted with its
  unused `companionContentType`). `.wasm` maps to `application/wasm`; without it the reader
  answers 404 for the ghostty module, which Vite emits as `assets/ghostty-vt-<hash>.wasm`
  through the `?url` import in `ghostty-companion-pane.ts`. The name regex
  `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` already accepted it; only the extension was missing. The
  companion smoke reads the built `assets/` directory, requires exactly one `.wasm`, and GETs
  it expecting that content type.
- **The page CSP needs `script-src 'self' 'wasm-unsafe-eval'`.** `default-src 'self'` alone
  blocks WebAssembly compilation with no visible error; `test/companion-page-boundary.test.ts`
  pins the exact CSP string in `src/renderer/companion/index.html`. Any reverse proxy in
  front of the listener must pass `application/wasm` through unchanged.
- **The phone pane is `TerminalPane`-shaped by conformance, not by import.** The boundary
  test forbids the page tree from importing `src/renderer/src/`, and the desktop adapter
  cannot render at a fixed grid anyway (it always fits). `CompanionTerminalPane` keeps the
  `mount`/`write`/`resize`/`dispose` names and the `events.onData` shape, and
  `test/companion-terminal-pane-seam.test.ts`, outside the page tree, assigns it to
  `Pick<TerminalPane, ...>` so `npm run typecheck` enforces the narrowing. ghostty-web is
  imported only by `ghostty-companion-pane.ts`; ghostty cannot run under happy-dom, so every
  page test fakes `createPane`.
- **The phone never resizes.** The pane is built with `cols`/`rows` from `opened`, has no fit
  controller, never subscribes `terminal.onResize`, and follows `geometry` frames. Three views
  (`companion-mirror-zoom.ts`), none of which resizes: `reflow`, the default, hides the grid
  and shows a `<pre>` the mount fills from the pane's `bufferLines` (`companion-mirror-reflow.ts`:
  wrapped rows joined back into one line, lines trimmed, trailing blanks dropped, rebuilt at
  most every 80 ms while output arrives, a view at the end kept at the end); the browser
  scrolls it and the touch gestures are off. The grid views are a CSS `transform: scale(...)`
  on the surface (`mirrorScale`), so the cell grid stays the desktop's: `fill-height` is
  `hostHeight / gridHeight` with the host panning sideways (`overflow-x: auto`, `touch-action:
  pan-x`) and the touch drag scrolling the pane by rows; `fit-width` is
  `min(1, hostWidth / gridWidth)`, with the scrollback (`bufferLines` minus the screen's rows,
  `historyText`) drawn in a `<pre>` above the grid inside the same surface, in the pane's
  `font()` at the grid's row height, and the host scrolling the two vertically. The extent
  around the surface takes the scaled size of what the surface holds. The choice lives in
  `localStorage` under `hvir-companion-mirror-zoom`, with the default standing in when storage
  refuses.
- **Touch scrolls the emulator, never the page.** `MirrorScrollGestures` listens on the host
  for touch and pen pointers, converts vertical travel into whole rows through the scaled row
  height (fraction carried, dropped on a direction change), and calls the pane's
  `scrollLines`, which routes through the shared `TerminalWheelController`
  (`src/shared/terminal-wheel.ts`, moved there from the desktop renderer): the normal screen
  moves the viewport, the alternate screen gets Page Up/Down, mouse tracking gets SGR. The
  `touchend` that closes a gesture is stopped in capture before the emulator's canvas takes it
  for a tap and raises the phone keyboard; a tap still passes.
- **The control bar is armed-only.** `MirrorControls` renders the Arm/Disarm button alone
  while disarmed and adds the key strip and the text form only while `armed`; the tests that
  look for `#companion-terminal-text` or the key buttons must arm first.
- **Emulator replies are dropped on the phone.** ghostty answers device-attribute and cursor
  queries synchronously inside `write` through the same `onData`; the pane counts write depth
  and ignores `onData` while writing, since those replies are the desktop renderer's to send.
- **SSE backlog is bounded by ending the mirror, not the page.** `sendTerminal` drops an
  `output` frame when `stream.backlog > SSE_MAX_BACKLOG_BYTES` (4 MiB) and calls
  `endMirror(pageId, 'overrun')`; the small `ended` frame that follows still goes out and the
  page reselects when it catches up.
- **`streamEvents` is an exhaustive switch.** A new `CompanionEvent` variant fails typecheck
  there rather than being sent as `closed`, which is what the earlier `else` did.
- **Selection is optimistic on the phone.** `select()` calls `feed.clear()`, marks the row
  selected, then POSTs; `opened` rides the separate SSE socket and can land before the reply,
  which is why the feed is handle-keyed and buffered. Back only clears page state: the server
  mirror stays until the next select or the page closes.
- **`CompanionRow` is exact-key checked.** `isCompanionRow` rejects unknown keys, so a new
  field goes into `ROW_REQUIRED_KEYS`/`ROW_OPTIONAL_KEYS` and the guard, and never `livePty`.
  `promptBody` is the optional-key example: `ROW_OPTIONAL_KEYS = ['reason', 'promptBody']`,
  and `isPromptBodyFor` admits it only when `attention` is `{ status: 'available', value:
  'prompt' }` and the string passes `isActionableAttentionBody` (1 to 120 characters). A
  `promptBody` beside a Ready, Bell, stale, or unsupported attention fails the whole row. The
  same shape holds one hop upstream: `isActionableAttentionEntry` admits `body` only on a
  `prompt` entry, and a missed validator there makes `app.ts` fall back to an empty set, which
  silently drops all attention rather than one field.
- **A prompt's message is not persisted.** The session registry stores `attention` only, so a
  restored `prompt` comes back without `promptBody`; the row and the mirror header show the
  badge and no line until the harness notifies again.
- **`prompt` is not `bell`.** The desktop pane event coordinator maps a `notification` event
  (OSC 9 and OSC 777 from `ghostty-terminal-events.ts`) to a `notification` effect with the
  bounded body, and only the BEL byte to `bell`. A prompt entry outranks Ready and Bell on the
  same terminal and a later notification replaces the body; Push does not fire for a terminal
  that was already in the set as Ready, since `appearances` keys on the entry's key alone.
- **The transcript path is untouched for hvir rows.** `select` still acquires the transcript
  lease; for a live hvir row it resolves synchronously to `unavailable not-projected` without
  reaching the transcript supervisor. The page hides that sentence while a mirror is live and
  shows the shared `sessionsTranscriptUnavailableMessage` otherwise; the phone never prints a
  reason code.
- **Settings save is exact-key.** `isCompanionConfigSave` rejects unknown keys, so
  `mirrorInputAllowed` had to be added to the view, the save, the store (`parseStored` reads
  `=== true`, file version stays 1), `saveOf` in all three branches, and `removeToken`.
  Forgetting one branch resets the flag silently on the next Apply.
- **No secret store in smoke.** `installSmokeCompanion` has no OS cipher; saving a Push token
  there throws. The mirror and prompt smokes save a push URL without a token for that reason,
  through the shared `companion-away-pairing.ts`.
- **The prompt smoke prints the sequence, it does not type it.** `companion-prompt-away`
  has the shell run `printf '\033]9;...\007'` with echo off and waits for the ESC and BEL
  bytes themselves in the PTY output; the typed command echoes backslash text, so only the
  running printf can match. It then requires the prompt entry with its body in main's set
  within `AWAY_PROMPT_BUDGET_MS`, the same body on the Companion row, and exactly one Push
  whose second line is the body.

## Failure modes seen here

- A `resize()` that threw inside node-pty after exit left the mirror-visible geometry ahead of
  the applied one; the supervisor now applies the host resize before it replaces
  `entry.geometry` and publishes.
- The first `PtyOutputTail.retain` was quadratic (re-joining on every chunk); a 256K-plus
  stream of one-character chunks took minutes. It appends in place and compacts from a head
  index now, with a 2 s bound in `test/pty-output-tail.test.ts`.
- `SseWriter.write` ignored the `write` return value, so a phone that stopped reading made the
  process buffer without bound; the backlog cap and `overrun` end are the fix.
- An arming that survived Back, reconnect, and a row switch let the first key on a new mirror
  through; the arming is now keyed to the mirror handle it was made for.
- The smoke `restoreWindow` called `win.focus()` only, which cannot make a shell-launched app
  frontmost on macOS; it now loops `app.focus({ steal: true })` like the other scenarios.
