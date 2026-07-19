---
compass_area: "project-host — the host/transport seam"
area_path: "src/main/project-host/"
generated: "2026-07-19"
# Staleness stamp — machine-readable so a refresh can test drift without a model.
# `sources` are area-relative paths (relative to THIS file's directory). Recompute:
#   node ~/.claude/skills/project-compass/compass-hash.mjs src/main/project-host/COMPASS.md
sources_hash: "sha256-16:79c18daf63ce2ec7"
sources:
  - project-host.ts
  - local-host.ts
  - ssh-host.ts
  - ssh-transport-pool.ts
  - ssh-exec-slots.ts
  - ssh-file-access.ts
  - ssh-watch-service.ts
  - ssh-remote-command.ts
  - ssh-config.ts
  - index.ts
---

# Compass: project-host — the host/transport seam

> Tribal-knowledge map for `src/main/project-host/`. The *why* and the *gotchas* —
> not the *what*. Canonical decision: `docs/adr/ADR-010-project-host-remote-boundary.md`.

## Purpose

This is hvir's **single transport seam** (ADR-010). Every filesystem read/write, buffered
and streaming exec, PTY spawn, directory watch, and bounded loopback TCP stream in the app
goes through `ProjectHost`, and every path is a host-qualified `HostPath`, never a bare
string. `LocalHost` is the default backend; `SshHost` implements the identical contract over
`ssh2` — **with no installed remote server**. The intent: nothing above this seam knows
whether a project is local or remote. Remoteness is latency, not a second product path.

## Key files & entry points

- **`project-host.ts`** — the contract, and a negotiated one. Options like `keepStdinOpen`,
  `allowTruncatedOutput`, `maxStdoutNulRecords`, `pollingInterest`, `expectedMtimeMs`, and
  `additionalPaths` exist only because SSH could not otherwise be made to behave like local.
  Also carries the `spawnPty` "do not call directly" contract (ADR-006) and
  `assertLoopbackEndpoint`, the sole gate for ADR-013 loopback panes.
- **`local-host.ts`** — the one module allowed to import `fs` / `child_process` / `chokidar`
  / `node-pty` (lint-enforced in `eslint.config.mjs`, greppable in `scripts/check-seams.sh`).
  Read it as the *behavioral reference* the SSH side must match.
- **`ssh-host.ts`** (~1.2k lines, capped in `architecture-hotspots.json`) — the logical host:
  identity, the auth ladder, host-key trust, reconnect/generation state, buffered-exec
  admission. Most of the tribal knowledge lives here.
- **`ssh-transport-pool.ts`** — the **capacity** authority, deliberately split from the
  **auth** authority. Encodes the control/terminal/tunnel role split so a burst of terminals
  cannot starve Git and SFTP.
- **`ssh-exec-slots.ts`** — the buffered-exec **admission** budget, split from the transport
  pool for the same reason: channels and admission answer different questions. Holds the
  interactive/background lane rules.
- **`ssh-file-access.ts`** — SFTP session multiplexing, a 2 s read/readdir cache, prefix
  invalidation, and the content-digest "optimistic save" authority.
- **`ssh-watch-service.ts`** — the no-daemon watch strategy: `inotifywait` over an exec
  stream when available, bounded SFTP polling otherwise, with a watchdog and adaptive scan.
- **`ssh-remote-command.ts`** *(fork-added)* — all remote shell-string construction: quoting,
  `env`/`cd` composition, login-shell wrapping, exit-status marker protocol. Pure and
  unit-tested precisely because a quoting bug here is remote command injection.
- **`ssh-config.ts`** — `~/.ssh/config` parsing with `~`, `%d`, `%h`, `%r` expansion.
- **`index.ts`** — the public surface. Only `SshHost` is exported as the remote façade; the
  three collaborators are private composition details (seam check #10).

## How it connects

- **Constructed in exactly one place:** `src/main/project-registry.ts` — owner of the `hosts`
  map, SSH-config loading, identity discovery, and `HostTrustStore`. `RendererSshPrompter`
  there bridges `SshAuthPrompter` to renderer modals with owner/generation scoping.
- **Privileged callers:** `pty/pty-supervisor.ts` is the *only* legal caller of `spawnPty`;
  `web-pane/loopback-http-proxy.ts` the only caller of `connectLoopback`;
  `git/worker-host-broker.ts` + `mutation-authorization.ts` re-validate untrusted git-worker
  calls in main (re-pin `hostId`, `git` only, no `cwd`, `-C` confined under the registered
  root). All four are enforced by `scripts/check-seams.sh`.
- **Ordinary callers** take `ProjectHost` as a *type*: `project-watch.ts` (multiplexes UI
  interests into `additionalPaths`), `workspace-coordinator.ts`, `ipc/features/filesystem.ts`
  (`pollingInterest: true`), `terminal/session-registry.ts`, all of `harness/`, and
  `beads/beads-service.ts` (the only `loginShell: true` caller).
- **Boundaries crossed:** process, network (SSH transport / SFTP / `forwardOut` direct-TCP),
  utility process (git worker calls arrive as `WorkerHostCall`), and heavy async — every SSH
  operation is a promise over an ssh2 callback.

## Gotchas & non-obvious constraints

- **Resolve the login shell *before* taking an exec slot.** `defaultShell()` itself execs;
  holding a buffered slot across that nested call deadlocks a pool of size one. Same for the
  connect-time inotify capability probe. This ordering is load-bearing, not stylistic.
- **`clientGeneration` is the anti-clobber mechanism.** A late `close` from a retired ssh2
  Client must not null out its replacement. `open()` bumps it, `files.advanceGeneration()`
  mirrors it, and a stale-generation SFTP session is rejected outright.
- **`readDigests` / `pollingFiles` deliberately survive `advanceGeneration()`** and clear
  only on `dispose()` — optimistic-save authority must outlive a reconnect.
- **Watch backends must never throw asynchronously.** They report through `opts.onError`;
  every caller relies on it.
- **`hostVerifier` is callback-only by design.** Returning a boolean would make ssh2 decide
  synchronously, before the user can answer the fingerprint prompt. Hence also
  `readyTimeout: 120_000` — an interactive fingerprint comparison must not time out.
- **Looks wrong, is load-bearing:** `void ready.catch(() => undefined)` in `execStream` (a
  listener-only caller may never await, and an early failure would be an unhandled
  rejection); installing `child.on('error')` before any caller can subscribe (a failed spawn
  emits immediately and would crash Node); a *persistent* — not `once` — `client.on('error')`
  because ssh2 surfaces agent/signing failures as Client errors and then continues the auth
  ladder; `reportExit(255)` on PTY channel close behind an `exited` guard, because some
  servers close a PTY channel without sending exit-status; `lstat` not `stat` (otherwise the
  `symlink` branch is unreachable); negative fake PIDs for remote PTYs; and `-l -c` as
  separate flags because **fish rejects the combined `-lc`**.
- **The exit-status marker is a security detail.** Buffered exec appends
  `__hvir_exec_status_<uuid>__<code>` to stderr; recovery validates 1–3 digits ≤ 255 and uses
  `lastIndexOf` so command output containing a marker-like string cannot spoof it.
- **Reconnect is suppressed after a prompt.** Max 5 attempts, `min(30s, 500·2^(n-1))`, but
  never if the failed attempt involved a modal — no retry loop in the user's face. Pool growth
  after a cancelled/refused prompt is blocked permanently until a fresh successful primary auth.
- **Credential policy:** password/passphrase cached in memory only on a *ready* connection;
  keyboard-interactive answers are never cached and the ladder is capped at 4 rounds to defeat
  adversarial challenge loops. `ssh2` passing `methods === null` means "unknown", not "none".
- **A slow command is a shared-resource problem, not a local one.** Four buffered execs run
  at once per host, and every subsystem draws on that one budget. A remote CLI that takes
  seconds — `gc session list` measured at ~3 s against ~40 ms for `bd` or `git status` — will
  hold most of it if it also sits behind a poll, and the git discovery a user is waiting on
  after a workspace switch queues behind it. That reads as the whole app being slow, which is
  why it was diagnosed twice as a network problem before anyone timed the command (the link
  is ~10 ms RTT). `ExecLane` is the answer: `lane: 'background'` on a periodic poll caps it
  at one slot (`SSH_MAX_BACKGROUND_EXECS`), leaving the rest interactive. The queue skips a
  waiting background exec rather than letting it block interactive work behind it —
  otherwise the reservation would just move the head-of-line stall one place down.
- **Capacity budgets:** 8 physical transports (2 control, 2 tunnel), 6 control / 8 terminal /
  16 tunnel channels, 5-minute idle grace, primary never retired. SFTP counts as a control
  channel. Channel-open failures retry 5× with `25·2^n` backoff, spilling to a healthy
  transport from attempt 2.
- **Path rules:** every incoming `HostPath` is checked against `hostId` and mismatch throws;
  outgoing paths are re-qualified via `hostPath(...)`, never hand-built. Remote path math is
  POSIX-only (no `node:path`). `assertLoopbackEndpoint` allows only ports 1–65535 on
  `localhost` / `127.0.0.1` / `::1`. `additionalPaths` is capped at 256 in both hosts.
- **`ssh-config.ts` drops wildcard `Host *` blocks entirely** — a user relying on a wildcard
  silently gets defaults.
- **Fork note:** `loginShell` is a *buffered-`exec`-only* option on the SSH side —
  `execStream` and `openTerminalPtyChannel` still build commands without it. See the fork
  section in `AGENTS.md`; `ssh-remote-command.ts` was extracted verbatim from `ssh-host.ts`
  so the extraction stays mergeable with upstream.

## Failure modes seen here

- Local watcher exhausting file handles (`EMFILE`/`ENOSPC`) → chokidar transparently restarts
  in polling mode.
- `inotifywait` missing, exiting, or *silently alive but emitting nothing* → fallback to
  polling plus a polling **watchdog**; a `fallingBack` flag prevents double-fallback.
- SFTP's second-resolution mtime hides same-second edits → content fingerprinting within a
  ~5 s observation window, and only for viewer-fetched files (internal bulk reads must not
  land on the polling fast path).
- Concurrent external edit during save → "File changed on the remote host since it was
  opened; reload before saving", plus partial-temp cleanup. Remote writes go to
  `.<basename>.hvir-<uuid>.tmp`, preserve mode, try `ext_openssh_rename` then plain `rename`.
- Multibyte UTF-8 split across chunks → `StringDecoder` on every stdout/stderr/PTY path.
- Transport exhaustion → a calm `sshCapacityError` that explicitly says existing sessions stay
  connected. An auxiliary transport's death kills only its pinned PTYs (exit 255).
- Polling errors are de-duplicated by message and suppressed after the watcher stops, so a
  persistent failure cannot spam `onError`.
- The recursive safety scan is batched (4 dirs/tick default, clamped 1–64) with adaptive
  backoff, so a huge remote tree cannot monopolize the SFTP session.
