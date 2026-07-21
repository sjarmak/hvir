# hvir — Agent Operating Notes

> The **intention + failure-mode-prevention** layer for agents working in this repo.
> It holds only what lives nowhere else; everything general is referenced, not copied.
> Keep it under ~120 lines. Boundary rules: see the `context-layering` practice in the bundle.

## What this project is

**hvir** = **H**arness · **V**iew · **I**nteract · **R**espond — a lightweight, **view-first**
workbench for agentic development: a code + git explorer wrapped around the terminals
(Claude Code, Codex, plain shells) you actually like. It is **not an IDE and not an
editor**. VSCode is more than we want; tmux is too hands-off; hvir sits between them.

**Read [`docs/design.md`](docs/design.md) before doing substantive work** — product
philosophy, guardrails, architecture, and the ADR index — plus the relevant canonical
records under [`docs/adr/`](docs/adr/README.md).

**Implementation and acceptance work is tracked in GitHub issues, commits, and pull
requests.** Do not add progress checklists, status logs, or test-run evidence to ADRs.
[`docs/plan/`](docs/plan/00-overview.md) is frozen historical context, not an active
tracker; do not update its checkboxes or status tables to record new work.

### This checkout is a customized fork — structure changes accordingly

This directory is the **main development checkout**, and it is a *variant* of hvir, not the
canonical copy (`git remote -v`): `origin` → `github.com/sjarmak/hvir`, this fork (the
"powerade" variant); `upstream` → `github.com/jarmak-personal/hvir`, the **canonical**
project. `~/hvir` and `~/jarmak-personal/hvir` are reference clones — **do not work there.**

The workflow is *pull upstream, re-apply customizations on top* — never the reverse.
**Sync** with `bash scripts/sync-upstream.sh` (merges `upstream/main` into the current
integration branch — `feat/beads-panel` today — then verifies; `git rerere` replays the
recurring shared-file conflict resolutions; needs a clean tree). **Contribute back** by
branching off `upstream/main`, cherry-picking, and PRing to `jarmak-personal/hvir`. Local
`main` carries **zero** fork commits and tracks upstream exactly — never land fork-only
work there. `package.json` `homepage`/`repository` point at the canonical repo on purpose.

**The fork must stay separable — the highest-value invariant here.** The customization
surface (`git diff upstream/main...HEAD`) is ~4k lines, almost all of it in
**self-contained new modules**: `src/main/beads/`, `src/renderer/src/beads/`,
`src/shared/beads*.ts`, `src/main/ipc/features/beads.ts`,
`src/main/project-host/ssh-remote-command.ts`, `test/beads-*`. Everything it adds to a file
upstream also owns is a **one-line** touch point (`src/main/index.ts`, `src/main/ipc.ts`,
`src/main/ipc/deps.ts`, `src/renderer/src/App.tsx`, `src/shared/index.ts`,
`src/main/smoke/index.ts`, `themes.css`) — composition is extracted into `beads-owner.ts` /
`BeadsRail.tsx` / `use-beads-workspace.ts` precisely so that stays true.

- **Add a module and wire it in one line.** Every extra line in a file upstream also edits
  is a merge conflict on *every* future sync.
- **Shape upstream-bound fixes as upstream-shaped commits** (small, isolated, no beads
  dependency) so they can be cherry-picked later — as with the harness-settings focus fix,
  the empty-providers crash fix, terminal-maximize persistence, the `ProjectHost`
  `loginShell` exec option, and the terminal `initialInput` hook.
- Where the fork must widen an upstream budget, **annotate it as fork headroom** — see the
  `Fork: +2 over upstream's cap` rationale in `scripts/architecture-hotspots.json`.

**Start substantive implementation from a governing GitHub issue.** Align on the problem,
product fit, architecture questions, and acceptance there before editing, then link the pull
request with `Closes #N`. Broad epics should be decomposed into independently reviewable child
issues; see [`CONTRIBUTING.md`](CONTRIBUTING.md).

**Do not spend effort drafting or creating an issue without the user's go-ahead.** An agent may
briefly propose using `hvir-create-issue`, but must wait for explicit approval before invoking
it. After drafting, it must show the exact issue and receive separate approval before publishing.

**Do not publish a pull request that fails locally runnable checks.** After the final changes,
run `npm run verify` before committing. Push without `--no-verify` so `.githooks/pre-push` runs;
if hooks are not installed, run that hook directly before pushing. Fix failures locally or
report an environment blocker instead of spending CI minutes on a known-bad branch.

## Hard constraints (do not violate without explicit sign-off)

- **No real editing.** "Minor edit + save" only. No LSP, debugger, refactors, extension
  host, task/build system. Editing is the guardrail; *surfacing information is not* —
  read-only telemetry (the v2 "harness viewer") is on-philosophy.
- **Nothing blocks the paint.** Heavy work — git walks, file watching, syntax tokenizing,
  large reads — runs off the render thread (utility processes / workers); the UI is always
  instantly responsive. This is how we earn "lighter than VSCode" (a *feel*, not a byte
  count — Electron's RAM cost is accepted deliberately).
- **The terminal is a swappable pane, not the foundation.** Keep it behind the
  `TerminalPane` interface; never bet the project on an unstable libghostty API.
- **Respect the seams.** All PTY spawning goes through the **PTY supervisor**; all
  harness-specific behavior (launch flags, resume commands, title conventions) stays behind
  the main-owned **harness provider registry/providers** (the evolved `HarnessAdapter`
  seam); the terminal stays behind **`TerminalPane`**; every filesystem/git/PTY/watch
  operation goes through **`ProjectHost`** (`LocalHost`/`SshHost`). Harness quirks never
  leak past their adapter (ADR-003, ADR-006, ADR-010). `scripts/check-seams.sh` is the
  executable statement of these seams — read it to learn them, and run `npm run verify`
  before claiming done.
- **Every path is host-qualified.** Paths are `(host, path)` pairs everywhere — no bare
  string paths, even in local-only code. Projects live on hosts; local is just the default
  host. (ADR-010)
- **Smart defaults, exposed controls.** View modes (rendered/source/diff per tab) and
  notifications (focus clears, parents aggregate) follow fixed, visible rules — no hidden
  magic, no special-casing. (ADR-007, ADR-009)

## Stack (see the ADR index in design.md)

Electron + electron-vite shell, React renderer, CodeMirror 6 + Shiki viewer (Monaco
fallback), system `git` binary off-thread (ADR-005), ghostty-web → libghostty terminals
(swappable), main-owned harness provider registry + launch profiles with exact
provider-owned resume and no daemon (ADR-006/012), project → discovered-worktree workspaces
(ADR-008), SSH via `ssh2` behind `ProjectHost` with no remote server (ADR-010). Targets:
Linux and modern macOS (both primary); Windows only if incidental.

## Conventions

- Prefer leveraging mature OSS over rebuilding.
- Before adding behavior, trace the current owner and search for equivalent policy or helpers.
  Share stable concepts through narrow, domain-named modules; do not create generic `utils`,
  catch-all `services`, service locators, or new responsibilities in composition roots.
- When making an architectural decision, add one decision-only record under `docs/adr/`
  using its template, then add it to the index in `docs/design.md`. Keep context, decision,
  consequences, and rejected alternatives in the ADR; keep implementation tracking in the
  issue/commit/PR history.
- Keep the non-goals in §2 of the design doc in view — resist "just one more thing."

## Failure-mode preventions

<!-- Append-only log of "don't do X here, it breaks Y" lessons from real incidents.
     One line each: the prevention, then the consequence it avoids.
     Add entries with the `failure-mode-capture` command, which dedupes against memory
     first so the same lesson is never stored in two layers. -->

_None recorded yet._

## Where to look (references)

- **Coding practices, agent roles, skills, workflows:** installed at the user level —
  `~/.claude/` (`rules/`, `agents/`, `skills/`, `commands/`) for Claude Code, `~/.codex/`
  for Codex, `~/.config/amp/AGENTS.md` for Amp.
- **Codebase compass (the "why" and gotchas, per area):** the `COMPASS.md` files indexed below.
- **Project docs:** [`docs/design.md`](docs/design.md), [`docs/adr/`](docs/adr/README.md),
  [`docs/packaging.md`](docs/packaging.md), [`README.md`](README.md).
- **Executable invariants:** `scripts/check-seams.sh`, `scripts/check-adrs.mjs`,
  `scripts/architecture-hotspots.json`; all run by `npm run verify`.

### Compass index

<!-- Generated and refreshed by the `project-compass` command. One line per area. -->

- `src/main/project-host/COMPASS.md` — the host boundary: `LocalHost` vs `SshHost`, and
  every fs/exec/watch/PTY primitive the rest of the app is denied.
- `src/main/harness/COMPASS.md` — provider registry, launch profiles, exact session resume,
  read-only context telemetry.
- `src/main/git/COMPASS.md` — the off-thread system-`git` engine: worker brokering, mutation
  authorization, porcelain parsing.
- `src/renderer/src/terminal/COMPASS.md` — the terminal deck: `TerminalPane` seam, session
  lifecycle, split/pane state, attention rollup.
- `src/main/beads/COMPASS.md` — **fork-only.** The read-only `bd` bridge and the beads panel
  it feeds; the largest single customization in this checkout.
- `src/main/gascity/COMPASS.md` — **fork-only.** The read-only `gc` bridge behind the crew
  section: what counts as a pinned lead, how sessions map to a rig, focus-or-attach.
