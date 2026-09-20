---
compass_area: "companion: the phone page's loopback listener, Sessions verbs, Push, and terminal mirror"
area_path: "src/main/companion/"
generated: "2026-09-19"
# Staleness stamp, machine-readable so a refresh can test drift without a model.
# `sources` are area-relative paths (relative to THIS file's directory). Recompute:
#   node ~/.claude/skills/project-compass/compass-hash.mjs src/main/companion/COMPASS.md
sources_hash: "sha256-16:43d97f29189e4547"
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
  - ../../shared/terminal-sticky-modes.ts
  - ../../renderer/companion/index.html
  - ../../renderer/companion/src/companion-terminal-pane.ts
  - ../../renderer/companion/src/ghostty-companion-pane.ts
  - ../../renderer/companion/src/companion-terminal-mount.ts
  - ../../renderer/companion/src/companion-client.ts
  - ../../renderer/companion/src/companion-mirror-feed.ts
  - ../../renderer/companion/src/companion-touch-scroll.ts
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
> `docs/adr/ADR-050-companion-live-terminal-mirror.md`,
> `docs/adr/ADR-051-terminal-notification-prompt-attention.md`, and
> `docs/adr/ADR-057-companion-mirror-shows-the-desktop-grid-at-every-focus.md`, which retired
> the Away size rule of `docs/adr/ADR-052-companion-mirror-holds-pty-size-while-away.md`, and
> `docs/adr/ADR-058-the-watching-phone-owns-the-grid.md`, which gave the size to the page that
> is watching rather than to any focus state.
> Operator view:
> `docs/runbooks/companion-operator.md`.

## Purpose

The Companion is the one network listener hvir owns (ADR-049 carves it out of ADR-010's
prohibition): a `node:http` server bound to `127.0.0.1` only, serving a second Vite entry as a
phone-sized page and a small `/api` behind a paired bearer credential. The page reads the same
Sessions projection the desktop reads, answers external sessions through the same transcript
port, and, under ADR-050, mirrors one live hvir-owned terminal per page and carries the user's
keystrokes back to it. A page that is watching owns the PTY's size for as long as it watches
(ADR-058). Away-time Push rides the same actionable set that drives the OS badge, and Away
decides nothing else here.
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
  a time, ends exactly once with a reason. `write` and `navigate` run through one `admit`:
  every lease refusal ends the mirror as `exited`.
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
  `mirror-controls.tsx`), and it holds the mount so `mirror-controls.tsx`'s `ReturnToLive`,
  the one control that sits over the terminal area rather than in the bar, can hand a tap
  back to the pane; `companion-terminal-mount.ts` builds the pane at the geometry main
  publishes, scales it to the host's width, and holds the PTY at the grid its area measures
  through `companion-terminal-fit.ts`, with `companion-touch-scroll.ts` turning a
  finger over the grid into the shared wheel policy's event shape (ADR-053) and carrying a
  flick on as a fling after the lift (ADR-057); `companion-client.ts` is the fetch layer;
  `ghostty-companion-pane.ts` is the only file that imports ghostty-web, fixes the mirror
  font at 15 px, and gives the emulator the desktop pane's 10 MB of scrollback;
  `use-input-arming.ts` and `companion-input-arming.ts` are the arming state.

## How it connects

- **Injected from `src/main/index.ts`** with `sessions: { ...sessionsPorts, sinks }`,
  `actionable: attention.set`, `mirrors: ptySupervisor`, the asset reader over the built
  renderer root, and `onDiagnostic` to `console.warn('[companion]', ...)`. The same root
  installs `terminal/mirror-input-notice.ts`, which forwards `PtySupervisor.onMirrorInput`
  to the owning renderer as `pty:mirror-input`, and `terminal/mirror-geometry-notice.ts`,
  which forwards `PtySupervisor.onMirrorGeometry` as `pty:mirror-geometry`, both through
  `RendererEventPublisher.toRenderer`.
  The supervisor takes no attention source: a bare `new PtySupervisor()` is the real one.
- **Downstream:** `sessions/sessions-observation-port.ts` (leases, snapshot, external
  resolution), `sessions/sessions-transcript-port.ts`, `sessions/sessions-companion-sinks.ts`
  (one sink per app), `attention/actionable-attention-set.ts`, and the PTY supervisor's
  `attachMirror` door, which bypasses the renderer owner gate and checks `(id, instanceId)`.
  A lease writes, navigates, and sizes: `viewport` holds the PTY at the watching page's
  grid (ADR-058), and the renderer's IPC handler is the other door that sizes one.
- **Wire contracts** live in `src/shared/sessions-companion.ts` (`CompanionEvent`,
  `CompanionTerminalEvent`, `CompanionMirrorEndReason`, `CompanionSnapshot.away`, the
  exact-key guards, the 256K tail, the 14-character sticky-mode preamble beside it, and the
  4096-character input bound) and
  `src/shared/companion-settings.ts`. Both are
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
`opened { cols, rows, preamble?, tail }` with the supervisor's retained tail and last applied
geometry, then `output` and `geometry` frames as the handlers fire.

`preamble` is the one field on the wire that main derived rather than forwarded (ADR-054).
`PtyOutputTail` is a flat 256K character window, so the alternate-screen enter a full-screen
program emits once at startup falls out of it and every replay would otherwise begin on the
normal screen while the session is on the alternate one. `TerminalStickyModes`, in
`src/shared`, scans the same chunks for a closed set of DEC private modes (1049 and 47, with
1047 observed as 47) and holds, per mode, the last state it saw and the position it saw it at.

The position is the part that is easy to get wrong. `preamble(windowChars)` names only the
modes whose last transition falls before the window it is handed, so a reader whose own bytes
still carry the enter gets nothing: prepending it anyway would switch the emulator to the
alternate screen before the replayed characters that belong on the normal one land, and the
desktop pane's scrollback for everything ahead of the full-screen program would be gone. The
renderer asks against its drained replay, a mirror asks against `lease.tail` through
`stream.retained`, and the page asks again against its own re-cut tail inside
`CompanionMirrorFeed`, because that window is cut independently of main's and keeps moving.

Three more constraints hold the field in this shape. It is optional, absent whenever the window
carries its own transitions, which is every ordinary shell, so such an `opened` is byte-identical
to what a page built before the field expects. It is never a prefix of `tail`: the tail
saturates at exactly its bound, so a prefix would push the `opened` past
`MAX_COMPANION_TERMINAL_TAIL_CHARS` and the guard's rejection kills the whole SSE stream, and
`CompanionMirrorFeed` re-cuts the tail from the front on every replay, so a prefix that fit
would vanish on the second paint. And it carries only modes with a steady state that change
the picture: `?1048` is a cursor save whose replay would let a later restore inside the tail
move the cursor mid-replay, a dangling `?2026` would freeze the reattaching emulator, and mouse
tracking would make the page's wheel policy answer a gesture with reports a disarmed mirror
drops.

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

## The watching page owns the grid (ADR-058)

For as long as a page holds a live mirror, that page's grid is the PTY's size. `CompanionFitController`
in `companion-terminal-fit.ts` divides the terminal area by the pane's own cell, waits 75 ms for the
layout to settle, and declares the grid over `POST /api/sessions/:handle/viewport`; the route reaches
`CompanionSessionsService.viewport`, the page's mirror lease, and `PtySupervisor.holdGeometryForMirror`,
which resizes the PTY, publishes the geometry to every mirror, and emits `pty:mirror-geometry` so the
desktop pane draws the held grid with a notice. Focus is not an input anywhere on that path: the fit
has no away door, the lease has none, and the supervisor has none. `CompanionSnapshot.away` is for Push.

The supervisor keeps `rendererGeometry` beside `geometry`: a desktop refit during a hold is recorded
and not applied, and the release puts the PTY back at that fit. The hold belongs to a token the lease
owns, so a stale lease releasing reclaims nothing and a second page taking the size over keeps it. Two
records before this one decided the size by focus (ADR-052 by Away, ADR-057 by refusing every mirror a
size at all); a real device found both wrong in the same way, which was that a person saw the view
change under them for a reason on the other side of the room.

A declaration is not typing: `viewport` is deliberately outside the `typingAllowed` gate, because
watching is what earns the size. A verb the desktop refuses is forgotten rather than retried on a
timer, and the page keeps drawing the size the PTY actually has, scaled, until a geometry frame says
otherwise.

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
  test forbids the page tree from importing `src/renderer/src/`, and the desktop adapter fits
  its own pane and nothing else does (ADR-050). `CompanionTerminalPane`
  keeps the `mount`/`write`/`resize`/`dispose` names and the `events.onData` shape, adds
  `cellSize()` for the fit, and
  `test/companion-terminal-pane-seam.test.ts`, outside the page tree, assigns it to
  `Pick<TerminalPane, ...>` so `npm run typecheck` enforces the narrowing. ghostty-web is
  imported only by `ghostty-companion-pane.ts`; ghostty cannot run under happy-dom, so every
  page test fakes `createPane`.
- **The phone asks for a size; it never draws one it only asked for.** The pane is built with
  `cols`/`rows` from `opened`, never subscribes `terminal.onResize`, and changes size only
  through `geometry` frames. The fit declares a grid and then waits for the frame that says the
  PTY took it, so a refused or lost hold shows as the scaled view rather than a screen the
  session has not laid out. No status line explains a size: there is nothing for a person to do
  about it.
  The one view is a CSS `transform: scale(...)` on the surface at `fitWidthScale` =
  `min(1, hostWidth / gridWidth)`, so the cell grid stays whatever main published: the
  desktop's wide grid shrinks to fit, and the phone's own grid draws at scale 1 (or a hair
  under, when a cell advance rounds past the host). The extent around the surface takes the
  scaled size of the grid, which is all the surface holds, and is a flex item with
  `margin-top: auto`, so a grid shorter than the host sits at its bottom
  edge and a taller one scrolls; `flex-shrink: 0` keeps the host from squashing it. Any rule
  that sets `display` on a hidden element defeats the `hidden` attribute, which is how the
  old reflow page leaked under the grid; there is no second view to hide now.
- **The emulator's own viewport is the whole read-back (ADR-053).** The page keeps no second
  text surface: it asks for no buffer lines and calls no `translateToString`, so colour,
  attributes, wide characters, and the cursor are exact by construction. There is one gesture
  and one policy. A wheel notch and a finger drag both reach `pane.scroll`, which routes
  through the shared `TerminalWheelController` (`src/shared/terminal-wheel.ts`, moved there
  from the desktop renderer): the alternate screen gets Page Up/Down, mouse tracking gets SGR,
  and anything the policy leaves alone moves the viewport by `deltaY / charHeight` with its
  sign kept, which is exactly what ghostty's own wheel path computes (`scrollLines` clamps
  `viewportY - amount`, so a negative amount reads back). `companion-touch-scroll.ts` owns
  `touchstart`/`touchmove`/`touchend`/`touchcancel` on the grid box in the capture phase and
  divides every delta by the mount's current transform scale, or the content crawls at a
  fraction of the finger's speed under a scaled desktop grid. It stops every `touchend` over
  the grid before ghostty-web's own canvas `touchend` can focus the hidden textarea, which
  `disableStdin` does not gate and which on a phone raises the soft keyboard and resizes the
  viewport; the mirror's typing surface is
  `MirrorControls`, so nothing over the grid wants that focus. `scroll` answers the distance
  the viewport did not take rather than a boolean, which is what keeps the host's own scroller
  honest: a sub-cell drag at the live edge hands back all of its pixels instead of banking
  them, and bytes that reached a program move no pixel of the surface, so the whole travel
  goes back. The mount treats the two scrollers as one strip end to end and fills the nearer
  one first, the host toward older content and the viewport toward the live edge, so a host
  scrolled down over a tall grid comes back up the same way. A gesture the policy claimed
  whose bytes the arming gate dropped is still the viewport's, so the default disarmed mirror
  reads back under a mouse-tracking program rather than going dead, and a disarmed mirror still
  pages a program that owns its history, because those bytes are not held by the arm. A reflow
  moves no viewport, so the pane re-anchors to `getScrollbackLength()` after a resize that
  shortens it.
- **What a gesture means is shared; what one step of it costs is not.** The steps are not the
  same size, so charging them all three lines is what made phone read-back jumpy: a viewport
  step is a row, but a page key is the whole screen, and at a scaled desktop grid three cells
  of finger came to roughly twenty on-screen pixels per PageUp, about thirty pages to a swipe.
  `stepCells` charges a drag half the rows it moves for a page and never less than a notch
  would, so dragging half a screen moves a screen; a notch keeps its three lines whatever it
  drives, and an SGR report stands for someone else's notch rather than for a screen, so it
  keeps them under a finger too. Which one this is travels on the event as `gesture`, set by
  `companion-touch-scroll.ts` for a finger and by `terminalWheelNotch` for everything else.
  Do not try to infer it from `deltaMode`: Chrome reports pixel deltas for plain mouse wheels
  on macOS, so it separates nothing. `terminalWheelNotch` reads the browser event's fields out
  one at a time because they are prototype accessors on `WheelEvent` and a spread copies none
  of them. `consumeSteps` banks the steps a clamped event could not carry, bounded by one
  event's worth, so distance decides how far a gesture travels rather than how the browser
  batched `touchmove`; it used to drop that overflow, which made the same drag land
  differently depending on batching.
- **One control returns the strip to the live edge, and position is all it knows.**
  `returnToLive()` on the pane is `scrollToBottom()`, and the position it answers about
  arrives through `events.onViewport` alone, which is the emulator's own `onScroll` read for
  `getViewportY()` rather than for the number the event carries, because a smooth scroll fires
  a floored value while the viewport rests on a fraction of a row. A subscription and no
  reader beside it: a wheel notch the policy leaves alone is scrolled by the emulator itself
  and reaches the mount through no call of its own, and the mount subscribes before it writes
  the queued frames, so a fresh pane needs no sample of a position it cannot yet have moved
  from. Zero is the live edge exactly, since every mover clamps with `Math.max(0, …)`, so the
  test is `offset !== 0` and never a floor. `CompanionTerminalMount.returnToLive()` is the
  mount's own verb and means the whole strip, not the viewport alone: it returns the emulator
  and then runs the host to the end of the extent, because over a grid taller than the phone
  the viewport's own live edge is still 480px above the newest rows. The mount reports the
  state outward the way it reports the screen, and `terminal-view.tsx` renders `ReturnToLive`
  over `.companion-terminal-area`: absolutely positioned, outside `.companion-terminal-host`,
  which is `overflow-y: auto` and would carry an absolutely positioned descendant away with its
  own scrolled content in exactly the tall-grid case that needs the control, and out of the
  area's flex flow, so a control that takes height never moves the grid under a finger. Both
  declarations are text-asserted in
  `test/style-ownership.test.ts`, since happy-dom applies no stylesheet and the rendered tests
  can only prove ancestry. The alternate screen is a condition of the render and not only of
  the emulator: ADR-053 forbids an affordance that moves nothing, so the view withholds the
  control on the alternate screen rather than trusting ghostty's own viewport reset to have
  landed first. Output arriving on a held viewport moves no row the person is
  reading: ghostty advances `viewportY` by whatever the scrollback grew, so the number changes
  and the reading does not, and the control correctly stays. An ended session keeps it, since
  the emulator still holds a screen and a newest output to get back to; a replaced or disposed
  mirror does not, and a surface rebuilt for another row clears it from the view. Disposing a
  pane releases every subscription it handed out, which the port states, so the mount holds no
  unsubscriber of its own for either `onData` or `onViewport`.
- **A mirror routes a gesture on what it knows, so it has to know (ADR-056).** A session under
  `tmux -g mouse on` has mouse tracking on, so the desktop's trackpad takes the SGR route and the
  program scrolls itself. The phone used to take the alternate-screen route instead and send
  `PageUp`, which tmux binds nowhere in its root table (`list-keys -T root | grep -ci ppage`
  returns 0) and hands to the program as a keystroke it barely honours: same PTY, same gesture,
  two routes, because the two emulators believed different things. The cause was ADR-054's
  carried set, which excluded the mouse family, while the program's `?1000h`/`?1006h` sat at
  attach time far outside any retained window. `CARRIED_MODES` now carries `?1000 ?1002 ?1003
  ?1006 ?1015` after the screens. Carry them by halves and it is worse than not carrying them:
  the policy needs `?1006` before it will synthesize a report, so a reader that knows the program
  tracks the mouse and cannot encode for it consumes every gesture and sends nothing, which is
  read-back dying with nothing on screen to say why. `STICKY_MODE_PREAMBLE_MAX_CHARS` went 14 to
  54 with them, and that is a wire bound: a page on an older bundle refuses an `opened` whose
  preamble exceeds what it knows, which ends its event stream.
- **The alternate screen says the program keeps its own history (ADR-055).**
  `pane.isAlternateScreen()` reads the emulator's mode flag, never the screen's text, and the
  mount reports the change to `terminal-view.tsx`, which renders one `companion-status` line in
  the terminal area. It is not inside `.companion-terminal-extent`,
  which is `overflow: hidden` at an explicit pixel size the fit writes every frame and would
  clip it. The line used to claim the session had no history, which is false for anything
  holding its own: tmux, a pager, a shell under tmux. What is true is that the emulator has no
  scrollback there, so the gesture pages the program instead.
- **Read-back navigation is not typing, on either side (ADR-055, widened by ADR-056).** What the
  wheel policy emits for a read-back gesture leaves the pane on `events.onNavigation` rather than
  `events.onData`, so the per-mirror arm does not hold it; everything else a gesture produces
  still passes `emitUser`. The split is `isTerminalReadBackNavigation` in
  `src/shared/terminal-wheel.ts`, which is the routes' own output and the closed set the wire
  guard admits `navigation: true` for: claim it on any other byte and `isCompanionInputRequest`
  refuses the request at 400. It is the two page keys plus the wheel reports the policy
  synthesizes, buttons 64 and 65 only. A press, a release (`m` rather than `M`), a drag report,
  and a modified wheel button are all typing. Main gates it on `typingAllowed()` like
  any key and then takes `lease.navigate` rather than `lease.write`, which is the same PTY
  write minus `sources.onInput`. That omission is the point: `pty-supervisor.ts` fans `onInput`
  to the owning renderer, which records it as terminal input and arms ADR-019, so a page key
  sent through `write` would push a notification about the person's own scrolling.
- **One gesture's reports travel as one ordered write, not one request each.** A finger over
  a mouse-tracking program makes wheel reports on every move, and posting
  each as its own request let the browser open them in parallel and the listener write them in
  whatever order they landed: a program paged up and then down could read the down first. The
  pane emits one event's reports as one string, and `companion-navigation-queue.ts` keeps one
  navigation request in flight per mirror, joining what arrives meanwhile into the next. The
  wire guard admits a batch as `isTerminalReadBackNavigationBatch`: one or more tokens of the
  same closed set, up to `MAX_COMPANION_INPUT_CHARS`, which the queue cuts to at a token boundary.
  A batch with anything else inside is still a 400. Main writes the batch to the PTY once. The
  lift of the finger reaches the pane as `endGesture`, which drops the policy's banked steps and
  the viewport's sub-cell fraction, so a slow drag's remainder is never owed to the next touch.
- **A drag delivers its travel; a notch is still held to five.** `terminal-wheel.ts` caps the
  SGR reports of one event at `MAX_SGR_REPORTS_PER_NOTCH` (5) for a wheel notch, which is many
  events per gesture, and at `max(5, rows)` for a drag, which is one event per move whose
  distance is the scroll (ADR-057). Before that a finger sent five reports a move and the rest
  died at the lift, which on a live Claude Code seat (one row or two per report, some 1900
  reports of history) read as a hard limit a few rows back. The lift itself is a fling when
  the last 100 ms of samples show 0.3 px/ms or more: `companion-touch-scroll.ts` keeps emitting
  the same drag from `requestAnimationFrame` at the lift's velocity decayed by 0.998 per ms
  until it drops under 0.02, and only then calls `end`; a finger landing on it ends it there.
  Tests drive the clock and the frames through the `now` and `frames` options, and the mount
  test freezes `performance.now` across a synthetic drag so a lift there is a stop.
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
