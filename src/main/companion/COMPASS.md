---
compass_area: "companion: the phone page's loopback listener, Sessions verbs, Push, and terminal mirror"
area_path: "src/main/companion/"
generated: "2026-09-18"
# Staleness stamp, machine-readable so a refresh can test drift without a model.
# `sources` are area-relative paths (relative to THIS file's directory). Recompute:
#   node ~/.claude/skills/project-compass/compass-hash.mjs src/main/companion/COMPASS.md
sources_hash: "sha256-16:373573ebec531eab"
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
  - ../../renderer/companion/index.html
  - ../../renderer/companion/src/companion-terminal-pane.ts
  - ../../renderer/companion/src/ghostty-companion-pane.ts
  - ../../renderer/companion/src/companion-terminal-mount.ts
  - ../../renderer/companion/src/companion-mirror-feed.ts
  - ../../renderer/companion/src/companion-input-arming.ts
  - ../../renderer/companion/src/use-input-arming.ts
  - ../../renderer/companion/src/use-companion-session.ts
  - ../../renderer/companion/src/companion-store.ts
---

# Compass: companion, the phone page's loopback listener, Sessions verbs, Push, and terminal mirror

> Tribal-knowledge map for `src/main/companion/` and the phone page under
> `src/renderer/companion/` that it serves. The *why* and the *gotchas*, not the *what*.
> Canonical decisions: `docs/adr/ADR-049-companion-observer-and-away-push.md` and
> `docs/adr/ADR-050-companion-live-terminal-mirror.md`. Operator view:
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
  `canMirror` and `canAnswer` as booleans instead.
- **`companion-settings.ts`**, **`companion-config-store.ts`**, **`companion-pairing.ts`**:
  `companion.json` (version 1), the pairing code and credential, `typingAllowed()` read
  straight from the store.
- **`away-push.ts`**, **`push-describe.ts`**, **`push-sink.ts`**: one Push per row entering
  the actionable set while Away; body is project and title, plus at most one prompt line.
- Phone page (`src/renderer/companion/src/`): `use-companion-session.ts` holds the one stream
  and every verb; `companion-mirror-feed.ts` is the page's bounded copy of the mirror stream;
  `companion-terminal-mount.ts` builds the pane at the desktop geometry and scales it;
  `ghostty-companion-pane.ts` is the only file that imports ghostty-web;
  `use-input-arming.ts` and `companion-input-arming.ts` are the arming state.

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
  ownership-guarded: no imports from `./ipc`, `electron`, main, or preload.
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
renderer records it as input and ADR-019 arming stays there; nothing in main classifies. The
notice is generation-gated by `toRenderer`, so an input that lands during a renderer document
swap arms nothing; that is documented in the runbook rather than worked around.

The phone gates before the network: `useInputArming` reports `armed` only while its arming was
made for the mirror that is live now, and `input` in `use-companion-session.ts` drops data
while disarmed. A 403 disarms and names Settings; a 409 names the ended terminal.

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
  controller, never subscribes `terminal.onResize`, and follows `geometry` frames. Fit to
  width is a CSS `transform: scale(min(1, hostWidth / gridWidth))` on the surface so the cell
  grid stays the desktop's.
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
  there throws. The mirror smoke saves a push URL without a token for that reason.

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
