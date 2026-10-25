# hvir — Design & Architecture

> A lightweight, view-first workbench for agentic development.
> A beautiful code + git explorer wrapped around the terminals you actually like.

**Role:** Living product/design overview
**Origin:** 2026-07-11
**Targets:** Linux (primary), modern macOS (primary). Windows only if incidental.

---

## 1. What this is (and the wedge)

hvir is **not an IDE and not an editor**. It is a *viewer* — a fast, beautiful way to
explore a codebase, its git history, and the terminals where agents (Claude Code, Codex,
etc.) are doing work.

The workflow it serves: **"I hand off to agents frequently, but I like to stay in the
loop and know what's going on."** Pure-terminal approaches (tmux) are too hands-off — you
can't explore a codebase or git history the way VSCode lets you. But VSCode is *more than
we want*: it's a full IDE, it strains with 5+ open directories and many terminals, and it
doesn't render as beautifully as something built view-first.

### The gap in the market

The current cluster of agent tooling (Conductor, Nimbalyst, parallel-code, Vibe Kanban,
Claude Squad) is **harness-first, exploration-second** — great at *running* parallel agent
sessions, weak at *beautifully exploring what they did*. hvir inverts that: a gorgeous
code/git explorer that happens to host your agent terminals. That inversion is the wedge.

---

## 2. Non-goals (scope guardrails)

Scope creep is endemic to this kind of tool — "just one more thing" is always tempting.
These are the lines we hold:

- **No real editing.** "Minor edit + save" only. The moment we add serious editing
  (LSP, refactors, debugger) we are rebuilding VSCode and inheriting its
  weight. Editing is the guardrail; **surfacing information is not.**
- **Bounded extension packages are permitted for 0.3.0** under [ADR-054](adr/ADR-054-isolated-extension-package-and-capability-boundary.md).
  No package code runs in main or the trusted workbench renderer. Third-party harness providers,
  terminal engines, unrestricted background execution, and build/task systems remain excluded.
- **No language servers, no debugger, no build/task system.**
- **Not a session orchestrator.** We host and observe terminals; we don't try to
  out-orchestrate the dedicated worktree managers. (We may *use* worktrees as our
  workspace unit — see §7 — but that's ergonomics, not orchestration.)

Note: the v2 "harness viewer" (tokens, usage, skills, MCPs) is **on-philosophy**, not
scope creep — it is read-only telemetry, still view-first. It's parked for v2 for focus,
not because it violates the guardrail.

---

## 3. Design principles

1. **Light is a feel, not a byte count.** We accept Electron's RAM cost. "Lighter than
   VSCode" means *fewer features and instant responsiveness*, not a smaller binary.
2. **Nothing blocks the paint.** All heavy work — git log walks, file watching across
   workspaces, syntax tokenizing, large-file reads — runs off the render thread (Electron
   utility processes / workers). The UI is always instantly responsive even when a
   workspace is churning. This perceived snappiness is ~90% of the "lighter" feel.
3. **View-first, edit-second.** Rendering quality is a feature. Optimize for the reading
   experience.
4. **Agent-aware by default.** Auto-titled terminals and at-a-glance notifications are
   first-class, not afterthoughts. This is what makes it *feel built for* agentic work.
5. **Swappable terminal.** The terminal engine is an interface, not a foundation
   (see §6).

---

## 4. Key decisions

Architecture decisions are canonical, decision-only records under
[`docs/adr/`](adr/README.md). Implementation and acceptance are tracked only in GitHub
issues, commits, and pull requests.

This index deliberately retains the former `design.md#adr-NNN-…` anchors. Existing links
therefore land on the matching entry below, whose title links to the canonical record.

### Read-first constraints

Read these repository-wide constraints before selecting feature-specific decisions:

- [ADR-001](adr/ADR-001-electron-shell.md): the Electron process and responsiveness boundary
  governs where every capability may perform expensive work.
- [ADR-010](adr/ADR-010-project-host-remote-boundary.md): host-qualified paths and `ProjectHost`
  authority govern project operations across local and SSH features.
- [ADR-014](adr/ADR-014-modular-monolith-ownership.md): capability ownership, inward dependencies,
  explicit resource lifetimes, and test altitude govern changes across the repository. Its budget
  paragraph has scoped replacements below; the other constraints remain active.
- [ADR-040](adr/ADR-040-complete-source-budgets-and-dependency-policy.md): source coverage, budget
  provenance, and runtime/type dependency rules govern all maintained source and normal verification.

Then read the decisions governing the feature and its public seams, such as terminal panes,
providers, Git, viewers, workspaces, or installation. Reading priority is separate from lifecycle:
an active feature decision is still binding in its scope, while a read-first record can be active
only in part. The notices below mirror each record's canonical lifecycle. **Partially superseded**
preserves every unaffected rule; **Superseded** preserves history only. Follow replacement chains
with their stated scopes, rather than treating a partial successor as retirement of a whole record.

### [ADR-001 — Electron as the shell](adr/ADR-001-electron-shell.md)

> Lifecycle: Active

Electron provides the cross-platform desktop shell; responsiveness comes from keeping heavy
work off the render thread.

### [ADR-002 — React on electron-vite for the render layer](adr/ADR-002-react-electron-vite.md)

> Lifecycle: Active

React and electron-vite provide the render/build layer while feature models and expensive
work stay outside the renderer root.

### [ADR-003 — Terminal is a swappable pane, not the foundation](adr/ADR-003-swappable-terminal-pane.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-045](adr/ADR-045-explicit-outside-project-viewing.md) | partial | Terminal file-link location restriction to the active workspace.

`TerminalPane` isolates engine choice, terminal-focused layout, and typed file-link
activation from the rest of the workbench.

### [ADR-004 — Code viewer: CodeMirror 6 + Shiki](adr/ADR-004-codemirror-shiki-viewer.md)

> Lifecycle: Active

CodeMirror supplies the read-first surface and Shiki supplies TextMate/VS Code-quality
highlighting without turning hvir into an IDE.

### [ADR-005 — Git engine: shell out to system git](adr/ADR-005-system-git-engine.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-021](adr/ADR-021-system-git-dirty-navigation-safety.md) | partial | Clean-worktree navigation prerequisite and handing every dirty branch switch or pull to the terminal.
> Superseded by: [ADR-963](adr/ADR-963-architecture-review-history-and-agent-worktrees.md) | partial | Creating no branch at all; the architecture review creates one hvir/architecture/ branch per agent launch.
> Superseded by: [ADR-970](adr/ADR-970-explicit-review-checkpoint.md) | partial | Git mutation scope, for explicit private review-checkpoint object/ref writes only.
> Superseded by: [ADR-974](adr/ADR-974-pull-request-worktree-creation.md) | partial | Git mutation scope, for one fetch and one tracking worktree add per explicit Create worktree action on a PR row.

System Git runs behind an off-thread engine and a main-owned `ProjectHost` broker; the few
mutations hvir exposes are exact, bounded navigation operations.

### [ADR-006 — Session recovery: harness resume, not a daemon](adr/ADR-006-exact-harness-recovery.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-020](adr/ADR-020-two-explicit-recovery-skips-forget-record.md) | partial | Indefinite recovery-record retention until explicit close.
> Superseded by: [ADR-031](adr/ADR-031-transparent-provider-context-assumptions.md) | partial | Requiring an authoritative context window for pressure presentation and one universal threshold pair.

The PTY supervisor and providers recover exact harness conversations from provider-owned
persistence; hvir does not guess ambient sessions or preserve PTYs in a daemon.

### [ADR-007 — Per-tab view mode: rendered / source / diff](adr/ADR-007-explicit-view-modes.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-054](adr/ADR-054-isolated-extension-package-and-capability-boundary.md) | partial | Requiring rendered, source, or diff modes for every viewer tab; extension UI uses only its declared meaningful representations.

Document tabs expose visible, sticky rendered/source/diff modes with predictable defaults
and sandboxed HTML rendering. Extension UI uses declared meaningful representations.

### [ADR-008 — Workspaces: project → worktree tiers](adr/ADR-008-project-worktree-workspaces.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-023](adr/ADR-023-closed-workspace-lifecycle.md) | partial | Every present discovered worktree remaining open and visible.
> Superseded by: [ADR-024](adr/ADR-024-demand-driven-terminal-workspace-lifecycle.md) | partial | Registration or discovery implying renderer terminal runtime materialization.
> Superseded by: [ADR-027](adr/ADR-027-demand-driven-workspace-activity.md) | partial | Periodic Git work refreshing activity for every open workspace.
> Superseded by: [ADR-033](adr/ADR-033-successful-discovery-dismisses-missing-workspaces.md) | partial | Missing worktrees remaining visible until explicit dismissal.
> Superseded by: [ADR-963](adr/ADR-963-architecture-review-history-and-agent-worktrees.md) | partial | Creating no worktree at all; the architecture review creates one hvir-owned worktree per agent launch.
> Superseded by: [ADR-968](adr/ADR-968-pull-request-workspace-navigation.md) | partial | Workspace selection existing only in the top tier, for explicit PR-row shortcuts into the existing workspace navigation owner.
> Superseded by: [ADR-974](adr/ADR-974-pull-request-worktree-creation.md) | partial | Creating no worktree at all; an explicit Create worktree action on a PR row creates one hvir-owned worktree for that PR.

Host-qualified registered projects own discovered worktree workspaces without making hvir a
worktree orchestrator.

### [ADR-009 — Notifications: focus clears, parents aggregate](adr/ADR-009-hierarchical-attention.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-019](adr/ADR-019-working-output-is-not-actionable-attention.md) | partial | Classifying ongoing post-submission output as actionable new-output attention.
> Superseded by: [ADR-053](adr/ADR-053-local-agent-workbench-access.md) | partial | Terminal-only attention vocabulary: add separate quiet report attention, cleared by viewing that report.
> Superseded by: [ADR-948](adr/ADR-948-exact-external-pending-interaction-attention.md) | partial | Terminal focus as the only rule that clears attention.
> Superseded by: [ADR-949](adr/ADR-949-companion-observer-and-away-push.md) | partial | The OS badge as the only attention surface while all hvir windows are unfocused.
> Superseded by: [ADR-951](adr/ADR-951-terminal-notification-prompt-attention.md) | partial | Terminal focus as the only rule that clears a terminal's own attention, for a prompt entry answered through the Companion mirror.

Terminal focus is the single clearing rule; workspace/project and OS surfaces only aggregate
the appropriate unseen child attention.

### [ADR-010 — Remote projects: `ProjectHost` seam, host-qualified paths, no remote server](adr/ADR-010-project-host-remote-boundary.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-045](adr/ADR-045-explicit-outside-project-viewing.md) | partial | Temporary document viewing addendum: location, document-type, and automatic image-read scope.
> Superseded by: [ADR-055](adr/ADR-055-connection-scoped-remote-agent-client.md) | partial | Prohibition on cached remote helper files, only for the bundled connection-scoped hvir-agent client; no remote service or daemon is authorized.
> Superseded by: [ADR-051](adr/ADR-051-approved-finite-connector-execution.md) | partial | Registered-root requirement for explicit approved connector execution and its application-local working context only.
> Superseded by: [ADR-949](adr/ADR-949-companion-observer-and-away-push.md) | partial | The prohibition on any hvir-owned network listener, for one loopback-bound Companion listener.

All project operations and paths are host-qualified behind `ProjectHost`; SSH remains a
bounded transport owned by one logical host, not an installed remote service.

### [ADR-011 — Distribution: one npm launcher, native payloads](adr/ADR-011-npm-native-payload-distribution.md)

> Lifecycle: Superseded
> Superseded by: [ADR-022](adr/ADR-022-platform-native-github-release-installation.md) | full | Entire decision.

One npm launcher selects integrity-checked native payloads for the supported Linux and
Apple-silicon macOS targets.

### [ADR-012 — Harness providers and launch profiles, not an extension host](adr/ADR-012-harness-providers-launch-profiles.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-015](adr/ADR-015-missing-resume-artifact-blocks-fresh-launch.md) | partial | Definitely absent or empty resume artifacts implicitly starting a fresh harness.
> Superseded by: [ADR-024](adr/ADR-024-demand-driven-terminal-workspace-lifecycle.md) | partial | Bare Shell defaults implicitly launching a session in an empty workspace.
> Superseded by: [ADR-036](adr/ADR-036-retire-static-harness-risk-classification.md) | partial | Provider launch-risk rules, derived risk in profile launch revision, and risk classification and acknowledgment.
> Superseded by: [ADR-054](adr/ADR-054-isolated-extension-package-and-capability-boundary.md) | partial | General extension-platform prohibition only; trusted bundled harness providers and their separate SDK decision remain unchanged.
> Superseded by: [ADR-053](adr/ADR-053-local-agent-workbench-access.md) | partial | Protected terminal environment vocabulary only: add instance endpoint and exact workspace/session targeting.
> Superseded by: [ADR-058](adr/ADR-058-explicit-command-once-terminal-handoff.md) | partial | Explicit fresh ordinary-shell command handoff only; persistent profiles, trusted providers, protected environment, and exact harness recovery remain unchanged.

Trusted main-owned providers supply exact harness semantics; data-only profiles customize
launches without opaque shell commands or third-party harness providers. General extension
packages use ADR-054's separate isolated capability boundary.

### [ADR-013 — User-activated loopback web panes over `ProjectHost` routes](adr/ADR-013-user-activated-loopback-web-panes.md)

> Lifecycle: Active

Explicit terminal-link activation creates a bounded, authenticated, workspace-owned route to
a hostile isolated web pane while preserving remote loopback origins.

### [ADR-014 — Modular monolith ownership and dependency discipline](adr/ADR-014-modular-monolith-ownership.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-035](adr/ADR-035-bounded-osc52-clipboard-write.md) | partial | Expiry and removal metadata requirement for the named terminal-runtime.ts 600-line non-growth cap.
> Superseded by: [ADR-040](adr/ADR-040-complete-source-budgets-and-dependency-policy.md) | partial | Architecture hotspot budgets paragraph: complete source budgets and extended dependency enforcement; authority/seam checks stay blocking.
> Superseded by: [ADR-054](adr/ADR-054-isolated-extension-package-and-capability-boundary.md) | partial | Excluding a plugin platform or additional isolation boundary; capability ownership, inward dependencies, lifecycle, styles, and test discipline remain unchanged.

Feature ownership, inward dependency direction, typed resource lifetimes, explicit style
order, seam checks, and blocking hotspot ratchets govern the existing process boundaries.

### [ADR-015 — Missing resume artifacts block implicit fresh launches](adr/ADR-015-missing-resume-artifact-blocks-fresh-launch.md)

> Lifecycle: Active
> Supersedes: [ADR-012](adr/ADR-012-harness-providers-launch-profiles.md) | partial | Definitely absent or empty resume artifacts implicitly starting a fresh harness.

A requested exact resume whose qualified provider artifact is missing remains visibly
unavailable without spawning a fresh harness or replacing the retained recovery identity.

### [ADR-016 — Bounded local runtime diagnostics](adr/ADR-016-bounded-local-runtime-diagnostics.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-025](adr/ADR-025-remove-renderer-responsiveness-diagnostic.md) | partial | Responsiveness episode candidate and its opt-in renderer diagnostic experiment.

Fixed-schema, content-free diagnostic evidence flows through one bounded local owner while
feature recovery stays feature-owned, workbench health remains separate from terminal attention,
and diagnostic sessions stay explicit, droppable, and local. The owner-by-owner [layout-integrity
evaluation](layout-integrity-evaluation.md) retains layout postconditions as pure or focused
Electron conformance and promotes no runtime detector.

### [ADR-017 — Defer direct diagnostic report delivery to harnesses](adr/ADR-017-defer-direct-diagnostic-report-delivery.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-026](adr/ADR-026-explicit-ssh-image-paste.md) | partial | Remote image staging and PTY injection prohibition only for explicit image paste in an exact supported focused terminal.
> Superseded by: [ADR-032](adr/ADR-032-explicit-document-review-handoff.md) | partial | PTY text delivery prohibition only for explicit prepared document-review payloads through revisioned atomic bracketed paste and exact PTY authority.

Preview plus explicit Copy or Save remains the report boundary until a bundled provider can prove
exact-session semantic submission, truthful host and attachment behavior, and revocable lifecycle
semantics without generic PTY injection or new persistence.

### [ADR-018 — Script-free first-use native payload preparation](adr/ADR-018-script-free-native-payload-preparation.md)

> Lifecycle: Superseded
> Superseded by: [ADR-022](adr/ADR-022-platform-native-github-release-installation.md) | full | Entire decision.

Platform packages carry no lifecycle scripts; the launcher verifies and atomically prepares one
common archived payload lifecycle in a bounded per-user cache while npm retains installation,
platform selection, integrity, and provenance authority.

### [ADR-019 — Working output is not actionable attention](adr/ADR-019-working-output-is-not-actionable-attention.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-009](adr/ADR-009-hierarchical-attention.md) | partial | Classifying ongoing post-submission output as actionable new-output attention.
> Superseded by: [ADR-034](adr/ADR-034-project-name-working-presentation.md) | partial | Working presentation being confined to the terminal row.
> Superseded by: [ADR-948](adr/ADR-948-exact-external-pending-interaction-attention.md) | partial | Actionable workspace, project, and OS attention counts including only distinct terminals.

Ongoing output after a submitted turn remains visible as low-salience Working state while
workspace and project rollups count only actionable Ready and bell signals.

### [ADR-020 — Two explicit recovery skips forget the hvir record](adr/ADR-020-two-explicit-recovery-skips-forget-record.md)

> Lifecycle: Active
> Supersedes: [ADR-006](adr/ADR-006-exact-harness-recovery.md) | partial | Indefinite recovery-record retention until explicit close.

One explicit skip retains and marks a decision-ready recovery record; a second consecutive skip
forgets only hvir's host-qualified metadata while provider-native recovery remains untouched.

### [ADR-021 — System Git decides dirty navigation safety](adr/ADR-021-system-git-dirty-navigation-safety.md)

> Lifecycle: Active
> Supersedes: [ADR-005](adr/ADR-005-system-git-engine.md) | partial | Clean-worktree navigation prerequisite and handing every dirty branch switch or pull to the terminal.

Explicit branch switches and fast-forward pulls may run with working-tree changes; system Git
decides whether it can preserve them while hvir retains its bounded mutation and authority model.

### [ADR-022 — Platform-native installation from immutable GitHub Releases](adr/ADR-022-platform-native-github-release-installation.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-011](adr/ADR-011-npm-native-payload-distribution.md) | full | Entire decision.
> Supersedes: [ADR-018](adr/ADR-018-script-free-native-payload-preparation.md) | full | Entire decision.
> Superseded by: [ADR-028](adr/ADR-028-capability-based-debian-linux-installation.md) | partial | Linux support matrix and unconditional Ubuntu AppArmor integration.
> Superseded by: [ADR-044](adr/ADR-044-manual-native-package-installation.md) | partial | Script-only installation, update, and removal surface and exclusion of direct native package installation.

One release-owned installer selects and verifies platform-native packages from an immutable
GitHub Release; native package managers own privileged installation and removal, while npm
distribution is retired after cumulative acceptance.

### [ADR-023 — Closed workspaces unload and resurface on bounded Git activity](adr/ADR-023-closed-workspace-lifecycle.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-008](adr/ADR-008-project-worktree-workspaces.md) | partial | Every present discovered worktree remaining open and visible.
> Superseded by: [ADR-027](adr/ADR-027-demand-driven-workspace-activity.md) | partial | Fixed per-worktree periodic status cadence.

Present inactive worktrees may close without changing Git; closed workspaces retain no runtime and
return without activation after comparable bounded Git activity or successful rediscovery.

### [ADR-024 — Demand-driven terminal workspace lifecycle](adr/ADR-024-demand-driven-terminal-workspace-lifecycle.md)

> Lifecycle: Active
> Supersedes: [ADR-012](adr/ADR-012-harness-providers-launch-profiles.md) | partial | Bare Shell defaults implicitly launching a session in an empty workspace.
> Supersedes: [ADR-008](adr/ADR-008-project-worktree-workspaces.md) | partial | Registration or discovery implying renderer terminal runtime materialization.

Registered worktrees allocate no terminal runtime by registration alone; explicit materialization,
session, PTY, presentation, and focus lifecycles remain independently owned.

### [ADR-025 — Remove the renderer-responsiveness diagnostic](adr/ADR-025-remove-renderer-responsiveness-diagnostic.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-016](adr/ADR-016-bounded-local-runtime-diagnostics.md) | partial | Responsiveness episode candidate and its opt-in renderer diagnostic experiment.
> Superseded by: [ADR-046](adr/ADR-046-react-owned-development-measure-containment.md) | partial | Requirement to preserve hvir's development Performance Timeline containment owner and budget fixture.

The low-confidence Long Tasks experiment and its complete opt-in runtime/reporting surface are
removed; independent capacity coverage and Electron's high-confidence unresponsive lifecycle
remain at their owning seams, while ADR-046 replaces hvir's development measure owner.

### [ADR-026 — Explicit SSH image paste through private remote materialization](adr/ADR-026-explicit-ssh-image-paste.md)

> Lifecycle: Active
> Supersedes: [ADR-017](adr/ADR-017-defer-direct-diagnostic-report-delivery.md) | partial | Remote image staging and PTY injection prohibition only for explicit image paste in an exact supported focused terminal.

An explicit paste gesture may privately stage a bounded local clipboard PNG on an SSH host and
insert its path into an exact supported native harness composer, with no daemon, submission,
generic prompt delivery, or repository artifact.

### [ADR-027 — Demand-driven Git workspace activity](adr/ADR-027-demand-driven-workspace-activity.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-008](adr/ADR-008-project-worktree-workspaces.md) | partial | Periodic Git work refreshing activity for every open workspace.
> Supersedes: [ADR-023](adr/ADR-023-closed-workspace-lifecycle.md) | partial | Fixed per-worktree periodic status cadence.
> Superseded by: [ADR-975](adr/ADR-975-bounded-background-workspace-sampling.md) | partial | A full demand-driven refresh sampling status for every present worktree of the project.
> Superseded by: [ADR-977](adr/ADR-977-focus-gated-workspace-polling.md) | partial | Periodic discovery and closed-workspace sampling running while no hvir window is focused.

Periodic discovery no longer implies status for every open worktree; exact activity status is
demand-driven, clean closed workspaces retain bounded sampling, and stable dirty filters cannot
form an unbounded passive write loop.

### [ADR-028 — Capability-based Debian Linux installation](adr/ADR-028-capability-based-debian-linux-installation.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-022](adr/ADR-022-platform-native-github-release-installation.md) | partial | Linux support matrix and unconditional Ubuntu AppArmor integration.
> Superseded by: [ADR-044](adr/ADR-044-manual-native-package-installation.md) | partial | Retained single-installer authority for user preparation and lifecycle invocation.

Linux installation depends on Debian package tools, runtime ABI, libraries, and a production
Chromium sandbox rather than distribution identity; Ubuntu 24.04 remains the conditional
AppArmor integration case and the same release artifacts are accepted across representative
userspaces on both architectures.

### [ADR-029 — Distinct signed macOS SSH acceptance channel](adr/ADR-029-distinct-macos-ssh-acceptance-channel.md)

> Lifecycle: Active

A contributor-only, Developer ID signed macOS application uses a distinct bundle identity and
state root for LAN SSH coexistence acceptance while the installed release remains the sole user
installation.

### [ADR-030 — Bounded project file operations and explicit external-source authority](adr/ADR-030-bounded-project-file-operations.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-081](adr/ADR-081-trusted-selected-source-trash.md) | partial | Visible workspace selection for recoverable deletion: permit the exact registered workspace visibly identified by a trusted extension-requested Trash review.
> Superseded by: [ADR-061](adr/ADR-061-explicit-managed-extension-delivery.md) | partial | External source acquisition and no-replacement rules only for explicitly granted managed extension delivery; ordinary Files remains unchanged.

One main-owned coordinator applies fixed targeting, confinement, collision, transfer,
verification, deletion, and lifecycle policy over immediate `ProjectHost` primitives; explicit
operation-scoped grants bound application-host sources outside registered projects.

### [ADR-031 — Transparent provider context assumptions](adr/ADR-031-transparent-provider-context-assumptions.md)

> Lifecycle: Active
> Supersedes: [ADR-006](adr/ADR-006-exact-harness-recovery.md) | partial | Requiring an authoritative context window for pressure presentation and one universal threshold pair.

Trusted bundled providers may expose a visible fixed context-capacity assumption and
provider-specific pressure thresholds through the serializable capability catalog while the
renderer remains provider-neutral and reported windows retain precedence.

### [ADR-032 — Explicit document review anchors and provider-safe handoff](adr/ADR-032-explicit-document-review-handoff.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-043](adr/ADR-043-source-review-for-text-files.md) | partial | Markdown-only document, source-anchor, and batch scope; rendered capture remains Markdown-only.
> Supersedes: [ADR-017](adr/ADR-017-defer-direct-diagnostic-report-delivery.md) | partial | PTY text delivery prohibition only for explicit prepared document-review payloads through revisioned atomic bracketed paste and exact PTY authority.

Host-qualified Markdown review uses exact on-disk anchors, bounded local persistence, explicit
payload bytes and destinations, and revisioned provider composer contracts through PTY authority.

### [ADR-033 — Successful discovery dismisses missing workspaces](adr/ADR-033-successful-discovery-dismisses-missing-workspaces.md)

> Lifecycle: Active
> Supersedes: [ADR-008](adr/ADR-008-project-worktree-workspaces.md) | partial | Missing worktrees remaining visible until explicit dismissal.

Current successful Git discovery automatically dismisses prunable and omitted workspaces through
one host-qualified resource-cleanup lifecycle without mutating the repository.

### [ADR-034 — Project-name Working presentation](adr/ADR-034-project-name-working-presentation.md)

> Lifecycle: Active
> Supersedes: [ADR-019](adr/ADR-019-working-output-is-not-actionable-attention.md) | partial | Working presentation being confined to the terminal row.

Provider-neutral Working state may animate a project name without becoming actionable attention,
changing navigation width, or overriding reduced-motion preferences.

### [ADR-035 — Bounded OSC 52 clipboard write](adr/ADR-035-bounded-osc52-clipboard-write.md)

> Lifecycle: Active
> Supersedes: [ADR-014](adr/ADR-014-modular-monolith-ownership.md) | partial | Expiry and removal metadata requirement for the named terminal-runtime.ts 600-line non-growth cap.

A live terminal may place bounded, decoded OSC 52 text on the application-host clipboard without
receiving any read access; valid text remains exact and main independently validates IPC authority
and UTF-8 byte size.

### [ADR-036 — Retire static harness risk classification](adr/ADR-036-retire-static-harness-risk-classification.md)

> Lifecycle: Active
> Supersedes: [ADR-012](adr/ADR-012-harness-providers-launch-profiles.md) | partial | Provider launch-risk rules, derived risk in profile launch revision, and risk classification and acknowledgment.

Launch syntax is not current runtime permission state; hvir removes profile-derived risk and
acknowledgment while preserving exact provider, host, artifact, and recovery authority.

### [ADR-037 — Promote tested pull-request candidates](adr/ADR-037-promote-tested-pull-request-candidates.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-038](adr/ADR-038-coherent-ci-attempts.md) | partial | First-attempt-only and rerun restrictions on otherwise exact candidate CI evidence.
> Superseded by: [ADR-048](adr/ADR-048-equivalent-ci-runs-and-epic-history-recovery.md) | partial | Single-run candidate selection and missing redundant run association metadata; recorded release merge acceptance remains required.

Strict first-attempt pull-request checks admit one exact candidate tree to merge and release,
while native certification moves to Release and capacity evidence moves to controlled machines.

### [ADR-038 — Trust one coherent CI attempt per candidate](adr/ADR-038-coherent-ci-attempts.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-037](adr/ADR-037-promote-tested-pull-request-candidates.md) | partial | First-attempt-only and rerun restrictions on otherwise exact candidate CI evidence.
> Superseded by: [ADR-048](adr/ADR-048-equivalent-ci-runs-and-epic-history-recovery.md) | partial | Selection among separately created equivalent workflow runs; current complete-attempt rules remain required.

One complete workflow attempt may certify an exact candidate after approval or an explicit full
rerun, while partial reruns and cross-attempt job assembly remain ineligible.

### [ADR-039 — Exact provider-derived session forks](adr/ADR-039-exact-provider-derived-session-forks.md)

> Lifecycle: Active

Harness sessions start only as fresh launches, exact resumes of registered identities, or explicit
provider-derived branches of registered identities; ambient transitions are never inferred.

### [ADR-040 — Complete source budgets and dependency policy](adr/ADR-040-complete-source-budgets-and-dependency-policy.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-962](adr/ADR-962-maintained-branch-local-verification.md) | partial | Local architecture provenance on the Beads-governed feat/beads-panel branch; upstream delivery and all structural checks remain unchanged.
> Superseded by: [ADR-069](adr/ADR-069-rust-client-source-policy.md) | partial | Maintained-source language list: add Rust and Cargo dispositions; all existing budget, provenance, and TypeScript/JavaScript dependency rules remain authoritative.
> Supersedes: [ADR-014](adr/ADR-014-modular-monolith-ownership.md) | partial | Architecture hotspot budgets paragraph: complete source budgets and extended dependency enforcement; authority/seam checks stay blocking.
> Superseded by: [ADR-048](adr/ADR-048-equivalent-ci-runs-and-epic-history-recovery.md) | partial | Recorded merged-PR requirement for tested non-policy epic history only; policy authorization remains unchanged.

Every maintained source file has a blocking budget, with a 500-line comfort signal, a 1,000-line
default, exact prior authorization for exceptions, and distinct runtime-cycle and type-direction
enforcement; ADR-014's ownership discipline remains accepted.

### [ADR-041 — Deterministic contributor status](adr/ADR-041-deterministic-contributor-status.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-042](adr/ADR-042-contributor-token-allocation-and-migration.md) | partial | Single-issue session assignments, cumulative-only attribution, historical exclusion, optional planning capture, and Recorded tokens/Token scope field retirement policy.

Contributor tools report token, Project, and acceptance facts; protected merge remains the
separate completion boundary.

### [ADR-042 — Contributor token allocation and historical reconciliation](adr/ADR-042-contributor-token-allocation-and-migration.md)

> Lifecycle: Active
> Supersedes: [ADR-041](adr/ADR-041-deterministic-contributor-status.md) | partial | Single-issue session assignments, cumulative-only attribution, historical exclusion, optional planning capture, and Recorded tokens/Token scope field retirement policy.

Deterministic contributor tooling allocates planning batches and subsequent counter differences,
retains unknown phase totals, and reconciles preserved historical evidence before deleting fields.

### [ADR-043 — Source review for workspace text files](adr/ADR-043-source-review-for-text-files.md)

> Lifecycle: Active
> Supersedes: [ADR-032](adr/ADR-032-explicit-document-review-handoff.md) | partial | Markdown-only document, source-anchor, and batch scope; rendered capture remains Markdown-only.

Source review accepts workspace UTF-8 text regardless of extension through the existing
anchor, persistence, and delivery contracts; rendered capture remains Markdown-only.

### [ADR-044 — Manual installation of existing native packages](adr/ADR-044-manual-native-package-installation.md)

> Lifecycle: Active
> Supersedes: [ADR-022](adr/ADR-022-platform-native-github-release-installation.md) | partial | Script-only installation, update, and removal surface and exclusion of direct native package installation.
> Supersedes: [ADR-028](adr/ADR-028-capability-based-debian-linux-installation.md) | partial | Retained single-installer authority for user preparation and lifecycle invocation.

Users may prepare and verify existing release packages for macOS Installer or Linux `apt`,
including native updates and package-owned removal; legacy npm migration remains installer-owned.

### [ADR-045 — Explicit outside-project file viewing](adr/ADR-045-explicit-outside-project-viewing.md)

> Lifecycle: Active
> Supersedes: [ADR-003](adr/ADR-003-swappable-terminal-pane.md) | partial | Terminal file-link location restriction to the active workspace.
> Supersedes: [ADR-010](adr/ADR-010-project-host-remote-boundary.md) | partial | Temporary document viewing addendum: location, document-type, and automatic image-read scope.


Explicit same-host file activation opens ephemeral read-only outside-project tabs; automatic
Markdown images remain within the canonical document directory and descendants.

### [ADR-046 — React-owned development measure containment](adr/ADR-046-react-owned-development-measure-containment.md)

> Lifecycle: Active
> Supersedes: [ADR-025](adr/ADR-025-remove-renderer-responsiveness-diagnostic.md) | partial | Requirement to preserve hvir's development Performance Timeline containment owner and budget fixture.

React owns cleanup of its development Performance measures; a development-only Electron fixture
uses browser observation to prove fixture-specific React work and an empty retained measure set
without adding product instrumentation.

### [ADR-047 — Local SSH configuration authority](adr/ADR-047-local-ssh-configuration-authority.md)

> Lifecycle: Active

Main owns bounded, fixed-destination SSH host additions and catalog refresh; chooser requests
own delivery and feedback, while existing logical hosts retain connection lifetimes.

### [ADR-048 — Equivalent CI runs and verified epic history recovery](adr/ADR-048-equivalent-ci-runs-and-epic-history-recovery.md)

> Lifecycle: Active
> Supersedes: [ADR-037](adr/ADR-037-promote-tested-pull-request-candidates.md) | partial | Single-run candidate selection and missing redundant run association metadata; recorded release merge acceptance remains required.
> Supersedes: [ADR-038](adr/ADR-038-coherent-ci-attempts.md) | partial | Selection among separately created equivalent workflow runs; current complete-attempt rules remain required.
> Supersedes: [ADR-040](adr/ADR-040-complete-source-budgets-and-dependency-policy.md) | partial | Recorded merged-PR requirement for tested non-policy epic history only; policy authorization remains unchanged.

Shared candidate evidence selects the latest equivalent CI run's complete current attempt;
architecture alone can recover tested non-policy epic history without claiming recorded approval.

---

### [ADR-049 — Extension package lifecycle and bounded retention](adr/ADR-049-extension-package-lifecycle.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-064](adr/ADR-064-explicit-extension-installation-acceptance.md) | partial | Separate Enable after explicit user-selected installation, including reinstall only.

Directory, ZIP and development-link sources share explicit revision acceptance, durable identity,
exact removal and bounded retention under the extension state writer.

### [ADR-050 — Extension contributions and action lifetimes](adr/ADR-050-extension-contributions-and-action-lifetimes.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-072](adr/ADR-072-sixteen-declared-extension-actions.md) | partial | Eight exported action declarations per installation only.

Visible contribution demand owns one isolated updater; finite named actions retain caller and
context through ordinary non-focusing viewer placement, hiding, and explicit close.

### [ADR-051 — Approved finite connector execution](adr/ADR-051-approved-finite-connector-execution.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-076](adr/ADR-076-bounded-connector-output-transfer.md) | partial | Connector output pages sharing the general 16 KiB reply envelope and unrestricted repeated public page delivery.
> Superseded by: [ADR-075](adr/ADR-075-session-launcher-update-trust.md) | partial | Mandatory canonical-target reapproval only for an explicit session-bound decision to trust updates at one exact launcher.
> Superseded by: [ADR-070](adr/ADR-070-explicit-local-workspace-program-connection.md) | partial | Mandatory manually supplied absolute executable input and separate Inspect step for explicit ordinary-human local-workspace connections only.
> Superseded by: [ADR-065](adr/ADR-065-passive-extension-program-connection.md) | partial | Mandatory manually supplied absolute executable input and separate Inspect step for application-local first-use connections only.
> Supersedes: [ADR-010](adr/ADR-010-project-host-remote-boundary.md) | partial | Registered-root requirement for explicit approved connector execution and its application-local working context only.

Native connector approval pins host-account trust and explicit contexts; finite execution stays behind ProjectHost.

### [ADR-052 — Shared workbench and guest presentation](adr/ADR-052-shared-workbench-and-guest-presentation.md)

> Lifecycle: Active

Browser-safe semantic tokens and primitive styles serve built-in views and revision-captured
optional guest assets; theme/settings, feature layout and authority retain their existing owners.

### [ADR-053 — Local agent workbench access](adr/ADR-053-local-agent-workbench-access.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-055](adr/ADR-055-connection-scoped-remote-agent-client.md) | partial | Application-local transport and client-only reference response ownership, only for SSH-forwarded requests and live remote reference commands, plus protected client-path/unavailable metadata and transport-owned PATH setup.
> Superseded by: [ADR-056](adr/ADR-056-explicit-local-extension-authoring.md) | partial | Standalone CLI physical filesystem edge limited to fixed shipped reference reads, for explicit local scaffold, validate and skill export only.
> Supersedes: [ADR-012](adr/ADR-012-harness-providers-launch-profiles.md) | partial | Protected terminal environment vocabulary only: add instance endpoint and exact workspace/session targeting.
> Supersedes: [ADR-009](adr/ADR-009-hierarchical-attention.md) | partial | Terminal-only attention vocabulary: add separate quiet report attention, cleared by viewing that report.

Private local sockets adapt existing public capability owners with independent standing
agent access, exact finite destructive confirmation and workspace-owned inert reports.

### [ADR-054 — Isolated extension packages and the public capability boundary](adr/ADR-054-isolated-extension-package-and-capability-boundary.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-064](adr/ADR-064-explicit-extension-installation-acceptance.md) | partial | Separate Enable for explicit user-selected installation only; passive discovery and all other revision actions remain unchanged.
> Supersedes: [ADR-007](adr/ADR-007-explicit-view-modes.md) | partial | Requiring rendered, source, or diff modes for every viewer tab; extension UI uses only its declared meaningful representations.
> Supersedes: [ADR-012](adr/ADR-012-harness-providers-launch-profiles.md) | partial | General extension-platform prohibition only; trusted bundled harness providers and their separate SDK decision remain unchanged.
> Supersedes: [ADR-014](adr/ADR-014-modular-monolith-ownership.md) | partial | Excluding a plugin platform or additional isolation boundary; capability ownership, inward dependencies, lifecycle, styles, and test discipline remain unchanged.

Validated immutable packages run in isolated guests through a scoped public capability contract.
Explicit revision and permission decisions retain separate authority; application-level viewing
does not grant project access. The initial directory-to-view slice needs no later capability.

### [ADR-055 — Connection-scoped remote agent client](adr/ADR-055-connection-scoped-remote-agent-client.md)

> Lifecycle: Active
> Supersedes: [ADR-010](adr/ADR-010-project-host-remote-boundary.md) | partial | Prohibition on cached remote helper files, only for the bundled connection-scoped hvir-agent client; no remote service or daemon is authorized.
> Supersedes: [ADR-053](adr/ADR-053-local-agent-workbench-access.md) | partial | Application-local transport and client-only reference response ownership, only for SSH-forwarded requests and live remote reference commands, plus protected client-path/unavailable metadata and transport-owned PATH setup.

A transport-only bundled Rust client reaches one host-scoped, generation-pinned SSH forward,
with bounded private cache retention and explicit additional capability grants.

### [ADR-056 — Explicit local extension authoring](adr/ADR-056-explicit-local-extension-authoring.md)

> Lifecycle: Active
> Supersedes: [ADR-053](adr/ADR-053-local-agent-workbench-access.md) | partial | Standalone CLI physical filesystem edge limited to fixed shipped reference reads, for explicit local scaffold, validate and skill export only.

Explicit offline scaffold, validation and skill export share package policy and descriptor-relative
local storage while public starter lifetimes and ordinary enablement retain their existing owners.

### [ADR-057 — Selected extension source reading](adr/ADR-057-selected-extension-source-reading.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-073](adr/ADR-073-exact-workspace-source-grants.md) | partial | Read-only workspace grant retention and contextual workspace read consent only.
> Superseded by: [ADR-068](adr/ADR-068-in-context-human-source-read-decisions.md) | partial | Settings-only application-local read-only root decision surface only.

Explicit source grants and selection-bound reads keep current instruction viewing separate
from connector authority, content acceptance and agent actions.

### [ADR-058 — Explicit command-once terminal handoff](adr/ADR-058-explicit-command-once-terminal-handoff.md)

> Lifecycle: Active
> Supersedes: [ADR-012](adr/ADR-012-harness-providers-launch-profiles.md) | partial | Explicit fresh ordinary-shell command handoff only; persistent profiles, trusted providers, protected environment, and exact harness recovery remain unchanged.

An exact admitted action may hand one structured command to a new ordinary shell terminal;
transient launch data never enters recovery, and handed-off terminals retain ordinary ownership.

### [ADR-059 — Public local Skillager management](adr/ADR-059-public-local-skillager-management.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-081](adr/ADR-081-trusted-selected-source-trash.md) | partial | Requiring an extension-selected project original to be revealed in Files before requesting its separate deletion action.
> Superseded by: [ADR-079](adr/ADR-079-selected-original-save-and-accept.md) | partial | Local management excludes selected external import; complete exact external inspection and one human Save and accept decision are permitted.
> Superseded by: [ADR-080](adr/ADR-080-bounded-sync-no-effect-summaries.md) | partial | Individual identity rows for every synchronization outcome; only the exact proven no-effect categories may be summarized.
> Superseded by: [ADR-071](adr/ADR-071-selected-skill-tasks-and-version-acceptance.md) | partial | Mandatory complete-file presentation and acknowledgment before accepting an exact version, and refusal of acceptance solely because a file format cannot be previewed.
> Superseded by: [ADR-060](adr/ADR-060-public-skillager-advanced-exposure.md) | partial | Exclusion of native adoption from local management; complete public preservation-backed adoption is permitted by this decision.
> Superseded by: [ADR-067](adr/ADR-067-cli-owned-personal-library-creation-defaults.md) | partial | Mandatory explicit initialization path and separate Git choice only.

Extension-local workflows consume verified public initialization, approved synchronization and
complete token-bound managed-copy plans; current reading and exact acceptance remain separate.

### [ADR-060 — Public Skillager advanced local exposure](adr/ADR-060-public-skillager-advanced-exposure.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-082](adr/ADR-082-selected-original-save-and-use.md) | partial | Separate import and adoption decisions for an explicitly selected unsaved native original.
> Superseded by: [ADR-072](adr/ADR-072-sixteen-declared-extension-actions.md) | partial | Prohibition on increasing the eight-action declaration ceiling only.
> Supersedes: [ADR-059](adr/ADR-059-public-local-skillager-management.md) | partial | Exclusion of native adoption from local management; complete public preservation-backed adoption is permitted by this decision.

Extension-local advanced choices consume complete public token plans, preservation semantics
and truthful per-target recovery through the existing bounded action and connector owners.

### [ADR-061 — Explicit managed extension delivery](adr/ADR-061-explicit-managed-extension-delivery.md)

> Lifecycle: Active
> Supersedes: [ADR-030](adr/ADR-030-bounded-project-file-operations.md) | partial | External source acquisition and no-replacement rules only for explicitly granted managed extension delivery; ordinary Files remains unchanged.

Explicit local export capture and exact SSH workspace grants admit bounded managed delivery,
with durable operation custody, no-replace publication, preservation, and deliberate recovery.

### [ADR-062 — Exact-source extension release artifacts](adr/ADR-062-exact-source-extension-release-artifacts.md)

> Lifecycle: Active

The existing immutable release model includes the ordinary Skillager ZIP, while independent
0.3.0 reference and clock fixtures retain released public-contract inputs.

### [ADR-063 — Passive accepted-revision extension navigation icons](adr/ADR-063-passive-extension-navigation-icons.md)

> Lifecycle: Active

Optional bounded package SVG path icons use only accepted captured bytes and passive masks;
invalid assets warn while text navigation remains usable. Existing contribution lifetime owns
retirement, without inline package markup or a new asset protocol.

### [ADR-064 — Explicit extension installation accepts its validated revision](adr/ADR-064-explicit-extension-installation-acceptance.md)

> Lifecycle: Active
> Supersedes: [ADR-049](adr/ADR-049-extension-package-lifecycle.md) | partial | Separate Enable after explicit user-selected installation, including reinstall only.
> Supersedes: [ADR-054](adr/ADR-054-isolated-extension-package-and-capability-boundary.md) | partial | Separate Enable for explicit user-selected installation only; passive discovery and all other revision actions remain unchanged.

Explicit native Add accepts and enables its exact validated copied revision through the existing
writer; passive discovery and permission admission retain their separate boundaries.

### [ADR-066 — Declared extension installation landing](adr/ADR-066-declared-extension-installation-landing.md)

> Lifecycle: Active

Optional manifest landing uses the exact explicit installation receipt and existing ordinary
navigation owners. Preparation stays unselected and unfocused; live intent selects only after
it settles. The deliberate Settings handoff preserves its existing unsaved application draft
while retiring hidden resources, with ordinary Close and Save semantics unchanged.

### [ADR-065 — Passive extension program discovery and trusted connection](adr/ADR-065-passive-extension-program-connection.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-077](adr/ADR-077-combined-project-connection-decision.md) | partial | Exclusion of an explicitly named workspace read scope from a trusted connection decision only.
> Superseded by: [ADR-070](adr/ADR-070-explicit-local-workspace-program-connection.md) | partial | Application-only restriction on setup hints and ordinary-human connection requests.
> Supersedes: [ADR-051](adr/ADR-051-approved-finite-connector-execution.md) | partial | Mandatory manually supplied absolute executable input and separate Inspect step for application-local first-use connections only.

Bounded passive program candidates feed the existing exact native approval decision after
installation or a visible human proposal; package, file and agent authority stay separate.

### [ADR-067 — CLI-owned personal library creation defaults](adr/ADR-067-cli-owned-personal-library-creation-defaults.md)

> Lifecycle: Active
> Supersedes: [ADR-059](adr/ADR-059-public-local-skillager-management.md) | partial | Mandatory explicit initialization path and separate Git choice only.

Explicit default creation consumes the public CLI's location and history policy; advanced
custom intent remains available, and unknown-target completion requires public reconciliation.

### [ADR-068 — In-context human source read decisions](adr/ADR-068-in-context-human-source-read-decisions.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-073](adr/ADR-073-exact-workspace-source-grants.md) | partial | Read-only workspace grant retention and contextual workspace read consent only.
> Supersedes: [ADR-057](adr/ADR-057-selected-extension-source-reading.md) | partial | Settings-only application-local read-only root decision surface only.

Current ordinary human instruction reads propose a canonical local scope through the existing
source-approval owner and a trusted in-context decision; metadata and agents receive no file authority.

### [ADR-069 — Rust client source coverage and dependency evidence](adr/ADR-069-rust-client-source-policy.md)

> Lifecycle: Active
> Supersedes: [ADR-040](adr/ADR-040-complete-source-budgets-and-dependency-policy.md) | partial | Maintained-source language list: add Rust and Cargo dispositions; all existing budget, provenance, and TypeScript/JavaScript dependency rules remain authoritative.

Rust client source receives ordinary physical-line budgets under `packages/hvir-agent/`.
Cargo metadata and exact disposable output remain distinct from maintained or generated source;
the client owns Rust build, dependency, and protocol evidence without requiring a toolchain for
unrelated contributor verification.

### [ADR-070 — Explicit local workspace program connection](adr/ADR-070-explicit-local-workspace-program-connection.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-077](adr/ADR-077-combined-project-connection-decision.md) | partial | Active-selection-only setup pin for explicitly targeted application views and exclusion of an explicitly named workspace read scope from the connection decision only.
> Superseded by: [ADR-074](adr/ADR-074-independent-host-connector-approvals.md) | partial | Single saved host binding per connector and disclosure of replacing another host during local connection only.
> Supersedes: [ADR-065](adr/ADR-065-passive-extension-program-connection.md) | partial | Application-only restriction on setup hints and ordinary-human connection requests.
> Supersedes: [ADR-051](adr/ADR-051-approved-finite-connector-execution.md) | partial | Mandatory manually supplied absolute executable input and separate Inspect step for explicit ordinary-human local-workspace connections only.

An explicit ordinary human project view can propose local program connection through its
main-admitted workspace, preserving host-scoped native approval and application-only Add setup.

### [ADR-071 — Selected-skill tasks and version acceptance](adr/ADR-071-selected-skill-tasks-and-version-acceptance.md)

> Lifecycle: Active
> Supersedes: [ADR-059](adr/ADR-059-public-local-skillager-management.md) | partial | Mandatory complete-file presentation and acknowledgment before accepting an exact version, and refusal of acceptance solely because a file format cannot be previewed.

Selected-skill tasks retain CLI authority, one exact-version acceptance decision, optional
complete-file inspection, and explicit trusted project targeting for independent views.


### [ADR-072 — Sixteen declared extension actions](adr/ADR-072-sixteen-declared-extension-actions.md)

> Lifecycle: Active
> Supersedes: [ADR-050](adr/ADR-050-extension-contributions-and-action-lifetimes.md) | partial | Eight exported action declarations per installation only.
> Supersedes: [ADR-060](adr/ADR-060-public-skillager-advanced-exposure.md) | partial | Prohibition on increasing the eight-action declaration ceiling only.

Packages may declare sixteen semantic actions within the existing manifest and discovery bounds;
invocation capacity, payloads, deadlines, caller provenance and grants remain independently bounded.


### [ADR-073 — Exact workspace source grants and contextual read requests](adr/ADR-073-exact-workspace-source-grants.md)

> Lifecycle: Active
> Supersedes: [ADR-057](adr/ADR-057-selected-extension-source-reading.md) | partial | Read-only workspace grant retention and contextual workspace read consent only.
> Supersedes: [ADR-068](adr/ADR-068-in-context-human-source-read-decisions.md) | partial | Read-only workspace grant retention and contextual workspace read consent only.

Read-only workspace source grants remain independently reusable and revocable; contextual requests use
only the caller's main-admitted exact workspace. Application scope and body confinement remain unchanged.

### [ADR-074 — Independent host connector approvals](adr/ADR-074-independent-host-connector-approvals.md)

> Lifecycle: Active
> Supersedes: [ADR-070](adr/ADR-070-explicit-local-workspace-program-connection.md) | partial | Single saved host binding per connector and disclosure of replacing another host during local connection only.

Native approvals coexist and revoke by exact host; bounded public status follows the caller's
admitted workspace while trusted Settings presents independent saved host bindings.

### [ADR-075 — Session launcher update trust](adr/ADR-075-session-launcher-update-trust.md)

> Lifecycle: Active
> Supersedes: [ADR-051](adr/ADR-051-approved-finite-connector-execution.md) | partial | Mandatory canonical-target reapproval only for an explicit session-bound decision to trust updates at one exact launcher.

Explicit session trust covers future targets of one exact launcher; contextual metadata makes
normal canonical-target changes actionable without rewriting the saved approval.

### [ADR-076 — Bounded connector output transfer](adr/ADR-076-bounded-connector-output-transfer.md)

> Lifecycle: Active
> Supersedes: [ADR-051](adr/ADR-051-approved-finite-connector-execution.md) | partial | Connector output pages sharing the general 16 KiB reply envelope and unrestricted repeated public page delivery.

Connector-only larger replies, finite delivered-byte accounting and one shared browser reader
make bounded output usable while preserving independent flood guards and receipt authority.

### [ADR-077 — Combined project connection decision](adr/ADR-077-combined-project-connection-decision.md)

> Lifecycle: Active
> Supersedes: [ADR-065](adr/ADR-065-passive-extension-program-connection.md) | partial | Exclusion of an explicitly named workspace read scope from a trusted connection decision only.
> Supersedes: [ADR-070](adr/ADR-070-explicit-local-workspace-program-connection.md) | partial | Active-selection-only setup pin for explicitly targeted application views and exclusion of an explicitly named workspace read scope from the connection decision only.

One human Connect decision composes independently owned native and exact workspace read grants;
explicit application-view destinations remain independent of ambient navigation.

### [ADR-078 — Reviewed extension setup files](adr/ADR-078-reviewed-extension-setup-files.md)

> Lifecycle: Active

Declaration-derived templates and immutable trusted reviews configure selected extension access
through the existing independent native, source and agent setting owners.

### [ADR-079 — Selected-original Save and accept](adr/ADR-079-selected-original-save-and-accept.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-083](adr/ADR-083-project-batch-save-and-accept.md) | partial | Limiting standalone Save and accept to one selected project original.
> Superseded by: [ADR-082](adr/ADR-082-selected-original-save-and-use.md) | partial | Mandatory separate replacement decision when the human explicitly chooses the combined Save and use task.
> Supersedes: [ADR-059](adr/ADR-059-public-local-skillager-management.md) | partial | Local management excludes selected external import; complete exact external inspection and one human Save and accept decision are permitted.

One human decision saves and accepts the exact external manifest/token version while preserving the project original and disclosing initialization and uncertainty.

### [ADR-080 — Bounded sync no-effect summaries](adr/ADR-080-bounded-sync-no-effect-summaries.md)

> Lifecycle: Active
> Supersedes: [ADR-059](adr/ADR-059-public-local-skillager-management.md) | partial | Individual identity rows for every synchronization outcome; only the exact proven no-effect categories may be summarized.

Complete public sync observations bind review and reconciliation; only exact no-effect categories are summarized, while consequential outcomes and recovery paths stay explicit.

### [ADR-081 — Trusted selected-source Trash review](adr/ADR-081-trusted-selected-source-trash.md)

> Lifecycle: Active
> Supersedes: [ADR-059](adr/ADR-059-public-local-skillager-management.md) | partial | Requiring an extension-selected project original to be revealed in Files before requesting its separate deletion action.
> Supersedes: [ADR-030](adr/ADR-030-bounded-project-file-operations.md) | partial | Visible workspace selection for recoverable deletion: permit the exact registered workspace visibly identified by a trusted extension-requested Trash review.

Extensions request one exact project-directory review; trusted Files owns confirmation, recoverable deletion and the target workspace’s viewer cleanup.

### [ADR-082 — Selected-original Save and use](adr/ADR-082-selected-original-save-and-use.md)

> Lifecycle: Active
> Supersedes: [ADR-060](adr/ADR-060-public-skillager-advanced-exposure.md) | partial | Separate import and adoption decisions for an explicitly selected unsaved native original.
> Supersedes: [ADR-079](adr/ADR-079-selected-original-save-and-accept.md) | partial | Mandatory separate replacement decision when the human explicitly chooses the combined Save and use task.

One human decision saves and accepts an exact native original and uses a managed Full or Stub
copy through Skillager’s complete compound public contract, with truthful separate stage results.

### [ADR-083 — Project batch Save and accept](adr/ADR-083-project-batch-save-and-accept.md)

> Lifecycle: Active
> Supersedes: [ADR-079](adr/ADR-079-selected-original-save-and-accept.md) | partial | Limiting standalone Save and accept to one selected project original.

A human selects project originals from Skillager's complete native inventory and saves and
accepts their exact versions through one bounded public batch decision, preserving originals
and truthful partial completion.

### [ADR-946 — Sessions projects external agent sessions without owning them](adr/ADR-946-projected-external-agent-sessions.md)

> Lifecycle: Active

Sessions admits sessions hvir never launched as one row each with a recorded origin and an
opaque handle, bounded to read, answer, and attach, with demand held per selection.

### [ADR-947 — Foreign supervisor loopback API as a bounded read-and-answer client](adr/ADR-947-supervisor-loopback-api-client.md)

> Lifecycle: Active

One main-owned client reaches a foreign supervisor through `ProjectHost` loopback on a declared
endpoint, exposing a narrow verb surface with pinned generated types and typed unavailability.

### [ADR-948 — A declared external pending interaction is actionable attention](adr/ADR-948-exact-external-pending-interaction-attention.md)

> Lifecycle: Active
> Supersedes: [ADR-009](adr/ADR-009-hierarchical-attention.md) | partial | Terminal focus as the only rule that clears attention.
> Supersedes: [ADR-019](adr/ADR-019-working-output-is-not-actionable-attention.md) | partial | Actionable workspace, project, and OS attention counts including only distinct terminals.

An authority-declared pending interaction rolls up as actionable attention cleared by
resolution rather than focus, carrying its freshness to every surface that counts it.

### [ADR-949 — The Companion is an away-time observer served by the running app](adr/ADR-949-companion-observer-and-away-push.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-009](adr/ADR-009-hierarchical-attention.md) | partial | The OS badge as the only attention surface while all hvir windows are unfocused.
> Supersedes: [ADR-010](adr/ADR-010-project-host-remote-boundary.md) | partial | The prohibition on any hvir-owned network listener, for one loopback-bound Companion listener.
> Superseded by: [ADR-950](adr/ADR-950-companion-live-terminal-mirror.md) | partial | The exclusion of a terminal screen and terminal input from the Companion, for live hvir-owned terminals under a mirror lease.

A paired phone client of the running app reads the Sessions inventory and answers external
sessions over a loopback listener the operator publishes, fed by the one actionable set that also
drives the badge and away-time Push.

### [ADR-950 — The Companion mirrors a live hvir terminal and carries its user's keystrokes](adr/ADR-950-companion-live-terminal-mirror.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-949](adr/ADR-949-companion-observer-and-away-push.md) | partial | The exclusion of a terminal screen and terminal input from the Companion, for live hvir-owned terminals under a mirror lease.
> Superseded by: [ADR-951](adr/ADR-951-terminal-notification-prompt-attention.md) | partial | No phone action clearing attention, for a prompt entry on the mirrored terminal.
> Superseded by: [ADR-952](adr/ADR-952-companion-mirror-holds-pty-size-while-away.md) | partial | A mirror never resizing the PTY, for a live mirror lease while the desktop is Away.
> Superseded by: [ADR-954](adr/ADR-954-sticky-terminal-modes-precede-the-replayed-tail.md) | partial | Main not interpreting the bytes it forwards, for a bounded scan of sticky DEC private modes emitted ahead of the replayed tail.
> Superseded by: [ADR-955](adr/ADR-955-read-back-navigation-is-not-typing.md) | partial | The per-mirror arm gating every byte and mirror input being recorded as terminal input, for the page keys a read-back gesture emits to a program that owns its history.
> Superseded by: [ADR-958](adr/ADR-958-the-watching-phone-owns-the-grid.md) | partial | A mirror never resizing the PTY, for as long as a Companion page is watching that PTY.

A Companion page holds a mirror lease on one live hvir-owned PTY: main forwards the retained
output tail, live bytes, and desktop geometry, the phone emulates them with ghostty-web, and
armed user keystrokes return to that exact instance without the mirror ever owning, resizing,
or composing anything.

### [ADR-951 — A terminal's in-band notification is actionable attention that carries its message](adr/ADR-951-terminal-notification-prompt-attention.md)

> Lifecycle: Active
> Supersedes: [ADR-009](adr/ADR-009-hierarchical-attention.md) | partial | Terminal focus as the only rule that clears a terminal's own attention, for a prompt entry answered through the Companion mirror.
> Supersedes: [ADR-950](adr/ADR-950-companion-live-terminal-mirror.md) | partial | No phone action clearing attention, for a prompt entry on the mirrored terminal.

A terminal's OSC 9 or OSC 777 notification raises a prompt attention at once, carrying the
harness's own bounded message through every attention surface and the Push line; it outranks
Ready and Bell, is cleared by desktop focus or by an answer sent from the Companion mirror, and
never comes from reading the screen.

### [ADR-952 — The Companion mirror holds the PTY's size while the desktop is Away](adr/ADR-952-companion-mirror-holds-pty-size-while-away.md)

> Lifecycle: Superseded
> Supersedes: [ADR-950](adr/ADR-950-companion-live-terminal-mirror.md) | partial | A mirror never resizing the PTY, for a live mirror lease while the desktop is Away.
> Superseded by: [ADR-953](adr/ADR-953-companion-mirror-reads-back-through-emulator-viewport.md) | partial | The page's own scrollback layer drawing above the grid for a shell's mirror, for the emulator's viewport as the one read-back surface.
> Superseded by: [ADR-957](adr/ADR-957-companion-mirror-shows-the-desktop-grid-at-every-focus.md) | full | Entire decision.

While every hvir window is unfocused, a live mirror lease may resize its PTY to the phone's own
grid so a full-screen program lays out for the phone; the desktop draws the held grid top-left
with a notice and reclaims the size within one fit cycle when any of its windows gains focus, and
the most recent phone resize wins when two phones hold one PTY.

### [ADR-953 — The Companion mirror reads back through the emulator's viewport](adr/ADR-953-companion-mirror-reads-back-through-emulator-viewport.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-952](adr/ADR-952-companion-mirror-holds-pty-size-while-away.md) | partial | The page's own scrollback layer drawing above the grid for a shell's mirror, for the emulator's viewport as the one read-back surface.
> Superseded by: [ADR-955](adr/ADR-955-read-back-navigation-is-not-typing.md) | partial | An alternate-screen session stating that it has no history to read back, for a program that keeps its own history and is paged through it.

The phone reads back by moving the emulator's own viewport, so history is drawn by the renderer
that draws the live screen and the page keeps no second text surface. A finger drag decides
under the one shared wheel policy, the page reads where the viewport is and never what it says
so ADR-019 and ADR-951 are untouched, and an alternate-screen session states that it has no
history instead of showing an empty column.

### [ADR-954 — Sticky terminal modes precede the replayed tail](adr/ADR-954-sticky-terminal-modes-precede-the-replayed-tail.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-950](adr/ADR-950-companion-live-terminal-mirror.md) | partial | Main not interpreting the bytes it forwards, for a bounded scan of sticky DEC private modes emitted ahead of the replayed tail.
> Superseded by: [ADR-956](adr/ADR-956-read-back-reaches-a-mouse-tracking-program.md) | partial | The mouse tracking family left to the window, for a mirror whose gesture the program's own wheel reports answer.

Main scans passing PTY output for a closed set of sticky DEC private modes, the alternate screen
`?1049` and `?47` and nothing else, keeping per mode the last state it saw and where it saw it,
with no screen model, cursor, or content. Each reader receives as a preamble only the modes the
window it is about to replay can no longer prove, carried as a distinct wire field rather than a
prefix, so a full-screen program's first frame is one grid instead of a stack of them. The page
repeats the same scan over its own buffer, whose window is cut independently and keeps moving.

### [ADR-955 — Read-back navigation reaches a mirrored program without being typing](adr/ADR-955-read-back-navigation-is-not-typing.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-950](adr/ADR-950-companion-live-terminal-mirror.md) | partial | The per-mirror arm gating every byte and mirror input being recorded as terminal input, for the page keys a read-back gesture emits to a program that owns its history.
> Supersedes: [ADR-953](adr/ADR-953-companion-mirror-reads-back-through-emulator-viewport.md) | partial | An alternate-screen session stating that it has no history to read back, for a program that keeps its own history and is paged through it.
> Superseded by: [ADR-956](adr/ADR-956-read-back-reaches-a-mouse-tracking-program.md) | partial | The exempt set closed at the two page keys, for the wheel reports the same policy sends a program that tracks the mouse.
> Superseded by: [ADR-960](adr/ADR-960-the-mirror-spends-its-height-on-the-session.md) | partial | The standing line the mirror showed for a program that keeps its own history, for the rows of the session that line stood on.

A program that owns its history, such as Claude Code under tmux, is read back from the phone by
paging it with the two keys the shared wheel policy already sends on the desktop. Those keys are
gated by the owner's mirror input permission alone, not by the per-mirror arm, and they reach the
PTY without being recorded as terminal input, so reading back raises no attention and sends no
Push. The exempt set is closed at those keys, typing still requires the arm, and the mirror stops
claiming an alternate-screen session has no history.

### [ADR-956 — A read-back gesture reaches a program that tracks the mouse](adr/ADR-956-read-back-reaches-a-mouse-tracking-program.md)

> Lifecycle: Active
> Supersedes: [ADR-954](adr/ADR-954-sticky-terminal-modes-precede-the-replayed-tail.md) | partial | The mouse tracking family left to the window, for a mirror whose gesture the program's own wheel reports answer.
> Supersedes: [ADR-955](adr/ADR-955-read-back-navigation-is-not-typing.md) | partial | The exempt set closed at the two page keys, for the wheel reports the same policy sends a program that tracks the mouse.

The sticky-mode scan carries the mouse tracking family whole, `?1000` `?1002` `?1003` `?1006`
`?1015`, so a mirror of a session under `tmux -g mouse on` routes a gesture the way its desktop
does instead of sending page keys the program barely honours. Read-back navigation becomes
whatever the one policy emits for a read-back gesture on any route, so the wheel reports it
synthesizes, buttons 64 and 65 alone, join the page keys outside the per-mirror arm and outside
the terminal input record. Carrying the trackers without the encoding is the silent failure
ADR-954 predicted, so the family moves together or not at all.

### [ADR-957 — The Companion mirror shows the desktop's grid whether or not the desktop is Away](adr/ADR-957-companion-mirror-shows-the-desktop-grid-at-every-focus.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-952](adr/ADR-952-companion-mirror-holds-pty-size-while-away.md) | full | Entire decision.
> Superseded by: [ADR-958](adr/ADR-958-the-watching-phone-owns-the-grid.md) | partial | One fit at every focus state, with the phone drawing the desktop's grid scaled, for the grid a watching page declares.

The phone shows the desktop's grid scaled to its width, and only that. A mirror never resizes
the PTY again, whether or not a desktop window is focused, so the desktop's fit controller is
the one author of a PTY's size and a focus transition resizes nothing. ADR-955 and ADR-956 had
already answered the history ADR-952 was for, and a real device found the phone-sized grid
laggy and the scaled one the view to keep. What the phone lacked was travel: a drag on the
mouse-tracking route now carries every report its distance earned, up to a screen of them per
event, a lift with speed behind it flings on until it rests, and the mirror keeps the desktop
pane's scrollback.

### [ADR-958 — The watching phone owns the grid](adr/ADR-958-the-watching-phone-owns-the-grid.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-950](adr/ADR-950-companion-live-terminal-mirror.md) | partial | A mirror never resizing the PTY, for as long as a Companion page is watching that PTY.
> Supersedes: [ADR-957](adr/ADR-957-companion-mirror-shows-the-desktop-grid-at-every-focus.md) | partial | One fit at every focus state, with the phone drawing the desktop's grid scaled, for the grid a watching page declares.
> Superseded by: [ADR-959](adr/ADR-959-the-phone-text-size-is-the-persons.md) | partial | One fixed readable mirror font, for a size the person sets on the device.

For as long as a Companion page holds a live mirror, that page's measured grid is the PTY's size:
the page declares it over a `viewport` verb, main applies and publishes it, and desktop focus is
not an input anywhere in the path. The desktop records its own fit while a hold is on, draws the
held grid with a notice, and takes its fit back when the mirror ends; the hold belongs to the
lease that took it, so a stale release gives nothing back. Until a geometry frame says the PTY
took the grid, the phone keeps drawing the size the PTY has, scaled to its width.

### [ADR-959 — The phone's text size is the person's](adr/ADR-959-the-phone-text-size-is-the-persons.md)

> Lifecycle: Active
> Supersedes: [ADR-958](adr/ADR-958-the-watching-phone-owns-the-grid.md) | partial | One fixed readable mirror font, for a size the person sets on the device.

The mirror's font is the one number that decides how much of a session a phone shows, since the
grid it holds the PTY at is its area divided by one cell. Fifteen pixels held about forty columns,
so the size becomes the person's: two steps beside the mirror's title walk a ladder of whole
pixels, the choice is stored on that device, and the default drops to ten, which is about sixty
columns on a phone's width. A step re-derives the grid and declares it through ADR-958's
`viewport` verb like any other layout change; nothing about the size itself leaves the phone.

### [ADR-960 — The mirror spends its height on the session](adr/ADR-960-the-mirror-spends-its-height-on-the-session.md)

> Lifecycle: Active
> Supersedes: [ADR-955](adr/ADR-955-read-back-navigation-is-not-typing.md) | partial | The standing line the mirror showed for a program that keeps its own history, for the rows of the session that line stood on.

The line ADR-955 showed over a full-screen program's grid, saying the program keeps its own
history, cost a row of the phone's screen for as long as that program ran, which on a phone is
most of the session. The mirror now shows the alternate screen with nothing standing over it: the
drag still pages the program through its history, the way back is still offered where a viewport
can move, and what the mirror says is what has just happened rather than what is continuously
true.

### [ADR-961 — Pinned native architecture review](adr/ADR-961-pinned-native-architecture-review.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-963](adr/ADR-963-architecture-review-history-and-agent-worktrees.md) | partial | The fixed comparison modes, the full recapture on revalidation, and the read-only single-file handoff consumed once per snapshot; pinned evidence, worker isolation, and launch authority remain.

Bounded host-qualified source snapshots drive a native subsystem review and exact source
viewer; request-owned workers extract facts while existing providers and Beads own explicit
handoffs.

### [ADR-962 — Maintained branch local verification](adr/ADR-962-maintained-branch-local-verification.md)

> Lifecycle: Active
> Supersedes: [ADR-040](adr/ADR-040-complete-source-budgets-and-dependency-policy.md) | partial | Local architecture provenance on the Beads-governed feat/beads-panel branch; upstream delivery and all structural checks remain unchanged.

The Beads-governed maintained branch verifies locally against a pinned policy baseline;
upstream GitHub provenance and blocking source/dependency checks retain their authority.

### [ADR-963 — Architecture review over history, with agent worktrees](adr/ADR-963-architecture-review-history-and-agent-worktrees.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-961](adr/ADR-961-pinned-native-architecture-review.md) | partial | The fixed comparison modes, the full recapture on revalidation, and the read-only single-file handoff consumed once per snapshot; pinned evidence, worker isolation, and launch authority remain.
> Supersedes: [ADR-005](adr/ADR-005-system-git-engine.md) | partial | Creating no branch at all; the architecture review creates one hvir/architecture/ branch per agent launch.
> Supersedes: [ADR-008](adr/ADR-008-project-worktree-workspaces.md) | partial | Creating no worktree at all; the architecture review creates one hvir-owned worktree per agent launch.
> Superseded by: [ADR-964](adr/ADR-964-architecture-review-as-a-live-zoomable-canvas.md) | partial | The map now opens on systems on a laid-out canvas that drills to subsystems and modules; explanation-only requests no longer create an agent branch, worktree, brief or terminal session, while architecture-improvement launches retain the worktree handoff.
> Superseded by: [ADR-965](adr/ADR-965-history-reads-the-fleet-commit-classification.md) | partial | Marking every History row and strip commit from its diff and import edges alone; a commit the fleet has classified is marked from its Architectural trailer instead.
> Superseded by: [ADR-967](adr/ADR-967-whole-monorepo-architecture-capture.md) | partial | The small-repository read budgets and default subsystem mapping across workspace packages; capture and classification use the expanded shared budgets and package boundaries refine default subsystems.

A snapshot compares any two refs or a ref and the live tree from Git objects through a blob-keyed
parse cache, opens on subsystem relationships across TypeScript, Python, Go and Rust, and hands
an agent a worktree hvir owns so the review can re-snapshot the agent's change. The History tab
marks each commit's architecture change against its parent, filters to architecture changes,
and opens the review on any commit; the commit strip lists the same commits newest first.

### [ADR-964 — Architecture review as a live, zoomable canvas](adr/ADR-964-architecture-review-as-a-live-zoomable-canvas.md)

> Lifecycle: Active
> Supersedes: [ADR-963](adr/ADR-963-architecture-review-history-and-agent-worktrees.md) | partial | The map now opens on systems on a laid-out canvas that drills to subsystems and modules; explanation-only requests no longer create an agent branch, worktree, brief or terminal session, while architecture-improvement launches retain the worktree handoff.

The map becomes a pan and zoom canvas of Systems, Subsystems and Modules laid out off the render
thread, a live review follows the working tree as a series of snapshots, and one direct model
call produces an Explanation shown as a claim beside what the scan observed without a worktree
or terminal handoff.

### [ADR-965 — History reads the fleet's commit classification](adr/ADR-965-history-reads-the-fleet-commit-classification.md)

> Lifecycle: Active
> Supersedes: [ADR-963](adr/ADR-963-architecture-review-history-and-agent-worktrees.md) | partial | Marking every History row and strip commit from its diff and import edges alone; a commit the fleet has classified is marked from its Architectural trailer instead.

History and the strip read the fleet's commit classification, one primary change type and its
orthogonal dimensions, from each commit's trailers and its note under refs/notes/classification,
mark a classified commit from its Architectural trailer, and keep the ADR-963 heuristic as the
permanent fallback for every commit the fleet has not classified.

### [ADR-966 — Scans reuse blobs by object id and analyses by fingerprint](adr/ADR-966-scans-reuse-blobs-by-object-id-and-analyses-by-fingerprint.md)

> Lifecycle: Partially superseded
> Superseded by: [ADR-967](adr/ADR-967-whole-monorepo-architecture-capture.md) | partial | The 32 MiB blob-cache budget; the cache remains twice the expanded capture byte budget.

The architecture review coordinator keeps two in-memory, byte-bounded, least-recently-used
caches for the life of the process: blob text by verified Git object id, shared by review scans
and the History classifier and filled by live reads too, and analyses by capture fingerprint, so
a repeat scan of an unchanged pair transfers no blobs and runs no worker. The blob-read span
reports transferred bytes and host calls only.

### [ADR-967 — Whole-monorepo architecture capture](adr/ADR-967-whole-monorepo-architecture-capture.md)

> Lifecycle: Active
> Supersedes: [ADR-963](adr/ADR-963-architecture-review-history-and-agent-worktrees.md) | partial | The small-repository read budgets and default subsystem mapping across workspace packages; capture and classification use the expanded shared budgets and package boundaries refine default subsystems.
> Supersedes: [ADR-966](adr/ADR-966-scans-reuse-blobs-by-object-id-and-analyses-by-fingerprint.md) | partial | The 32 MiB blob-cache budget; the cache remains twice the expanded capture byte budget.

Whole-repository budgets preserve package and service relationships without sampling.
Kotlin joins the grammar scanners, workspace imports resolve through captured manifests,
and symbolic links and submodules remain disclosed exclusions.

### [ADR-968 — Pull request shortcuts to existing workspaces](adr/ADR-968-pull-request-workspace-navigation.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-008](adr/ADR-008-project-worktree-workspaces.md) | partial | Workspace selection existing only in the top tier, for explicit PR-row shortcuts into the existing workspace navigation owner.
> Superseded by: [ADR-974](adr/ADR-974-pull-request-worktree-creation.md) | partial | The PR workspace action creating no checkout; a PR with no verified checkout may offer Create worktree.

PR rows open or reopen an existing workspace through the current navigation owner after matching
its host-qualified checkout and configured upstream to the PR source repository and branch.


### [ADR-969 — Demand-scoped Needs you navigation](adr/ADR-969-demand-scoped-needs-you-navigation.md)

> Lifecycle: Active

A foreground-only destination combines existing session attention with bounded read-only
Beads and PR snapshots across registered, connected workspaces. Source owners retain
classification and navigation authority; launch profile identity is not runtime provenance.

### [ADR-970 — One explicit review checkpoint per workspace](adr/ADR-970-explicit-review-checkpoint.md)

> Lifecycle: Active
> Supersedes: [ADR-005](adr/ADR-005-system-git-engine.md) | partial | Git mutation scope, for explicit private review-checkpoint object/ref writes only.

Explicit user actions save or clear one private Git tree baseline without changing HEAD,
branches, working files, or staging; foreground comparison remains read-only.

### [ADR-971 — Selected hosted pull-request feedback handoff](adr/ADR-971-selected-hosted-pr-feedback.md)

> Lifecycle: Active

The active-workspace GitHub owner supplies bounded, explicitly requested review threads.
Selected feedback remains untrusted text in an exact preview with clipboard-only handoff;
workspace, pull-request, and head drift invalidate its selection.

### [ADR-972 — Explicit Companion instance links](adr/ADR-972-companion-instance-links.md)

> Lifecycle: Active

Named origin-local links navigate between independently paired Companion pages.
Current endpoint identity stays visible; leaving releases demand and disarms input.
No shared credentials, cross-origin reads, discovery, or combined view are introduced.

### [ADR-973 — Persisted commit classification markers](adr/ADR-973-persisted-commit-classification-markers.md)

> Lifecycle: Active

Diff-derived commit markers persist on disk per repository, keyed by commit, parent, scanners
and layout; unclassified commits and fleet labels are never stored. Hidden views withdraw
queued classification requests.

### [ADR-974 — Pull request worktree creation](adr/ADR-974-pull-request-worktree-creation.md)

> Lifecycle: Active
> Supersedes: [ADR-005](adr/ADR-005-system-git-engine.md) | partial | Git mutation scope, for one fetch and one tracking worktree add per explicit Create worktree action on a PR row.
> Supersedes: [ADR-008](adr/ADR-008-project-worktree-workspaces.md) | partial | Creating no worktree at all; an explicit Create worktree action on a PR row creates one hvir-owned worktree for that PR.
> Supersedes: [ADR-968](adr/ADR-968-pull-request-workspace-navigation.md) | partial | The PR workspace action creating no checkout; a PR with no verified checkout may offer Create worktree.

An open same-repository PR with no checkout offers one explicit action that fetches, then adds
`<root>.hvir-worktrees/pr-<number>` on the PR head branch tracking its remote, under exact grants.

### [ADR-975 — Bounded background workspace sampling](adr/ADR-975-bounded-background-workspace-sampling.md)

> Lifecycle: Active
> Supersedes: [ADR-027](adr/ADR-027-demand-driven-workspace-activity.md) | partial | A full demand-driven refresh sampling status for every present worktree of the project.

A full refresh always samples the active workspace; a background worktree is re-sampled when its
HEAD or branch moves and otherwise at most once per thirty seconds, so shared `.git` bursts from
agent-driven worktrees no longer run status across the whole project on every event.

### [ADR-976 — Pull request waits by holder and business time](adr/ADR-976-pull-request-waits-by-holder-and-business-time.md)

> Lifecycle: Active

The pull request query carries per-reviewer state and request events; shared pure modules
derive who holds each pull request and for how long in business time, and the GitHub rail
and Needs you list the oldest ask first with no poller, store, or GitHub write.

### [ADR-084 — Isolated Mermaid rendering](adr/ADR-084-isolated-mermaid-rendering.md)

> Lifecycle: Active

Mermaid layout runs in a separate sandboxed browser renderer behind a finite viewer-owned
port; bounded passive SVG returns to the workbench without granting the computation page
filesystem or application IPC authority.

### [ADR-085 — Picker-scoped local destinations for SSH downloads](adr/ADR-085-picker-scoped-ssh-downloads.md)

> Lifecycle: Active

A native folder selection authorizes one verified SSH download to that exact local directory,
with operation-scoped authority and no additional confirmation.

---

### [ADR-977 — Focus-gated workspace polling](adr/ADR-977-focus-gated-workspace-polling.md)

> Lifecycle: Partially superseded
> Supersedes: [ADR-027](adr/ADR-027-demand-driven-workspace-activity.md) | partial | Periodic discovery and closed-workspace sampling running while no hvir window is focused.
> Superseded by: [ADR-978](adr/ADR-978-focus-gated-ssh-refresh-pulses.md) | partial | Synthetic SSH refresh pulses on the active-workspace and Git-metadata watches refreshing workspace Git state while no hvir window is focused.

Periodic workspace refresh runs every thirty seconds only while an hvir window is focused and
refreshes immediately on focus gain; demand-driven refreshes are unchanged and the broker keeps
`core.fsmonitor=false`.

### [ADR-978 — Focus-gated SSH refresh pulses](adr/ADR-978-focus-gated-ssh-refresh-pulses.md)

> Lifecycle: Active
> Supersedes: [ADR-977](adr/ADR-977-focus-gated-workspace-polling.md) | partial | Synthetic SSH refresh pulses on the active-workspace and Git-metadata watches refreshing workspace Git state while no hvir window is focused.

An SSH watch's synthetic two-second refresh pulse runs no workspace Git refresh while no hvir
window is focused; real watch events still refresh at once, and a focused hvir handles pulses
as before.

## 5. Architecture

### Process model
```
┌─────────────────────────────────────────────────────────────┐
│ Main process (Electron)                                      │
│  - window/lifecycle, menus, workspace registry               │
│  - IPC broker                                                │
└───────────────┬───────────────────────────┬─────────────────┘
                │                            │
     ┌──────────▼──────────┐      ┌──────────▼──────────────────┐
     │ Renderer (React)    │      │ Utility processes / workers │
     │  - file explorer    │◄────►│  - git engine (log/diff)    │
     │  - git explorer     │ IPC  │  - file watcher (chokidar)  │
     │  - tabbed viewer    │      │  - syntax tokenizer (Shiki) │
     │  - terminal panes   │      │  - large-file / blob reads  │
     │  - workspaces bar   │      └─────────────────────────────┘
     └─────────────────────┘
     (terminal PTYs spawned in main/utility, streamed to panes)
```

The rule from §3.2: if it can stall, it does not live in the renderer.

The `ProjectHost` boundary (ADR-010) is main-owned. The Git utility process proxies its
bounded host operations back through main; watchers and the PTY supervisor also use the
registered `LocalHost` or `SshHost`. Renderer features reach these capabilities only
through typed IPC and never access the filesystem directly.

### Component map
| Area | Choice | Notes |
|---|---|---|
| Shell | Electron + electron-vite | ADR-001/002 |
| Render layer | React | ADR-002 |
| Code viewer | CodeMirror 6 | read-first; Monaco fallback |
| Syntax highlight | Shiki | the "beautiful" payoff |
| View modes | rendered / source / diff per tab | ADR-007 |
| Markdown render | markdown-it + Shiki | rendered by default (ADR-007) |
| HTML render | webview / iframe (sandboxed) | **security req:** no node integration, strict CSP, block navigation |
| File tree | custom tree + chokidar watcher | watcher off-thread; open tabs live-reload on external change |
| Git engine | system `git` binary (simple-git / thin wrapper) | ADR-005; off-thread |
| Terminals | ghostty-web → libghostty | ADR-003, swappable |
| PTY | node-pty behind the **PTY supervisor** | spawned off-renderer; ADR-006 |
| Harness integration | main-owned **harness provider registry** + launch profiles | ADR-006/012 |
| Session recovery | exact harness resume via the active provider | ADR-006/012 |
| Remote projects | **`ProjectHost`**: `LocalHost` / `SshHost` (`ssh2`) | ADR-010; every path is `(host, path)` |

### UI layout
```
┌────────────────────────────────────────────────────────────────────┐
│ Projects bar — project tabs (host badge and attention rollups);    │
│ persistent worktree/workspace context tier beneath                 │
├──────────┬────────────────────────────────────────┬────────────────┤
│ Left     │ Viewer — tabs w/ view mode             │                │
│ rail     │ (rendered / source / diff),            │  Right rail    │
│          │ side-by-side splits                    │  open          │
│ file     ├────────────────────────────────────────┤  terminals,    │
│ tree /   │ Terminals (Ghostty panes,              │  auto-titled,  │
│ git      │ splits like VSCode)                    │  notification  │
│ explorer │                                        │  dots          │
└──────────┴────────────────────────────────────────┴────────────────┘
```

---

## 6. The terminal risk (resolved for v1)

Embedding *Ghostty specifically* was the founding design's one load-bearing unknown.
Phase 2 resolved the v1 delivery path; native embedding remains a future upgrade:

- **Native libghostty** is usable but remains unversioned, with API signatures and the
  embedding surface still moving; taking it directly would add native renderer and
  packaging work on both primary platforms.
- **`electron-libghostty`** is not a viable package today: its `0.0.0` tarball contains
  only package metadata and no implementation.
- **`ghostty-web`** is maintained, carries Ghostty's VT engine as WASM, and provides the
  xterm-shaped browser surface the Electron renderer needs. Phase 2 verified it on
  Linux and macOS.

**Mitigation (ADR-003):** the terminal is behind a `TerminalPane` interface. Because
`ghostty-web` is xterm.js-API-compatible, we inherit the entire mature xterm.js ecosystem
*and* Ghostty's engine, and can fall back to plain xterm.js if needed — then upgrade to
the full native libghostty widget when Linux embedding matures. The project never bets on
an unstable API.

**Current decision:** `ghostty-web` is the v1 engine behind `TerminalPane`; ADR-003 owns
the durable choice and its fallback/revisit conditions. Historical spike execution is
preserved in Git and the frozen implementation plan, not in the decision record.

---

## 7. Agent-aware features (the differentiator)

### Auto-titled terminals
Terminals already emit OSC 0/2 title sequences, and CC/Codex set them. We read those and
label the right-rail terminal list automatically — no manual naming. (Title conventions
live in `HarnessAdapter` — ADR-006.) Codex defaults its terminal title to spinner and
project, which duplicates the project rail; hvir-launched Codex sessions request its
supported `thread-title` item so the rail receives the conversation title through OSC.

### Notification dots
Raise a color dot on a terminal when it wants attention. Signals and the
focus-clears/parents-aggregate rule are ADR-009; the headline signal is
**idle-after-burst** — "the agent stopped and is waiting for me" — with bell and
new-output as secondary channels. Dots roll up terminal → worktree → project (ADR-008).

### Session recovery
Close hvir mid-run and nothing is lost: sessions resume deterministically through the
harness's own persistence (`--session-id` at launch → `--resume` on restart). ADR-006.

### The "what did the agent change" view
History/blame is table stakes; the killer view is the **working-tree and branch-point
diff** — what changed since I last looked, per worktree, one keystroke from the file
view (ADR-007). Git change details stay in the Git and file views instead of adding
persistent counts to project and workspace navigation.

### Workspaces
First-class multiple directories, without VSCode's multi-root heaviness. Two tiers:
**project** (registered) → **worktrees** (discovered), per ADR-008 — a workspace = a
worktree = a place an agent is working, with notification rollups at each tier.

### Global Sessions
The [Sessions ownership and topology-feasibility gate](sessions-ownership-and-feasibility.md)
defines the demand-scoped read-only projection, usage observation, exclusive live-terminal
surface lease, and current provider-topology boundary. It composes the existing session,
PTY, host, provider, attention, runtime, and `TerminalPane` owners without creating a global
authority or background observer.

---

## 8. MVP path

The founding MVP sequence established the shell, viewer, terminal, remote-host, Git,
attention, recovery, workspace, and polish surfaces described above. Its detailed phase
documents remain as [historical implementation context](plan/00-overview.md), not an
active tracker or acceptance ledger.

Current work is selected and accepted in GitHub issues. This document continues to own
the product boundary and architecture; an issue that requires a new durable architecture
choice adds or supersedes an ADR before implementation silently changes that boundary.

---

## 9. Open questions

Open product and architecture questions are tracked as GitHub issues so they have one
owner, discussion, and acceptance history. A resolved question that changes a durable
boundary becomes an individual ADR and an entry in §4. This section retains the founding
anchor for inbound links without maintaining a second research queue.

---

## 10. References

- libghostty roadmap — https://mitchellh.com/writing/libghostty-is-coming
- awesome-libghostty (embed projects) — https://github.com/Uzaaft/awesome-libghostty
- Ghostling (embed example) — https://github.com/ghostty-org/ghostling
- Embedded apprt / Linux support discussion — https://github.com/ghostty-org/ghostty/discussions/11722
- parallel-code (prior art) — https://github.com/johannesjo/parallel-code
- Electron `<webview>` API and stability warning — https://www.electronjs.org/docs/latest/api/webview-tag
- Electron `webContents` navigation, attachment, input, and proxy-auth events — https://www.electronjs.org/docs/latest/api/web-contents
- Electron security guidance for remote content — https://www.electronjs.org/docs/latest/tutorial/security
- Electron session and proxy API — https://www.electronjs.org/docs/latest/api/session
- Chromium proxy behavior for loopback origins — https://chromium.googlesource.com/chromium/src/+/312b6bf/net/docs/proxy.md
