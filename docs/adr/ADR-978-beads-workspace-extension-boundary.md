# ADR-978: Beads workspace extension boundary

> Lifecycle: Active
> Supersedes: [ADR-969](ADR-969-demand-scoped-needs-you-navigation.md) | partial | Bead selection routing through the built-in Beads panel owner.

## Context

The maintained fork has a built-in Beads rail and Gas City crew surface. Their main-process
services, private IPC, renderer models, and presentation duplicate the public extension
platform that now owns isolated views, finite workspace connectors, contribution placement,
and explicit terminal handoff. Keeping both paths would make the fork carry a second package
runtime and would let tool-specific policy leak across the public capability boundary.

The replacement must preserve the behavior of the built-in channels `beads:list`, `beads:probe`, `gascity:crew`, `gascity:probe`, `gascity:analytics-config`, `gascity:attention`, `gascity:attention-changed`, and `project:watch`, listed in the capability map below:
Beads listing and availability, Gas City crew and availability, analytics configuration,
Gas City attention, project-watch refresh, terminal commands and session attachment,
Needs you deep links, and left-rail placement. It must also work for SSH workspaces without
granting a guest filesystem, process, host-discovery, or authentication authority.

Beads stores are commonly changed by another process through Dolt. A filesystem watch is not
a correctness signal for those writes. The existing panel therefore refreshes while visible;
moving it into an extension must not disguise polling as a project-watch capability.

## Decision

The Beads and Gas City workspace surface becomes one installed extension package. It declares
one workspace left-navigation view, one updater, and two workspace connectors: `bd` and `gc`.
The package owns its view state, Beads grouping and presentation, crew joins, command argument
construction, and analytics/evaluation URL derivation. hvir does not retain a built-in Beads
panel as a fallback.

### Refresh and connector execution

The package refreshes by executing its approved connectors, not by subscribing to a filesystem
watch. Its updater may schedule refreshes only while ADR-050 supplies current foreground demand.
Each refresh is a finite `connector.execute` request subject to ADR-051's deadline, output,
concurrency, sharing, and one-second minimum-interval rules. The package uses a five-second
normal cadence, backs off after unchanged results or failure, and exposes an explicit Refresh
action. Losing the last visible demand cancels the timer and denies further updater connector
requests. Returning to the view performs an immediate refresh before resuming the cadence.

The package treats every result as an as-of snapshot. Connector failure, truncation, timeout,
or unavailable configuration remains visible and never becomes an empty successful result.
No `project:watch` event is added: it would miss the shared-store writes that motivated the
refresh and would create a false correctness contract.

### Needs you navigation input

Needs you remains a core application destination and cross-workspace read owner. Its Beads
classification and attention aggregation must run without the extension view being visible.
Selecting one of its Beads rows resolves the installed contribution for that row's exact
host-qualified workspace, opens that declared workspace view through the contribution owner,
and supplies bounded input `{ "focusBeadId": "..." }`.

The public platform must add a trusted targeted-view-input operation for this path. The
trusted renderer names an already admitted installation, revision, contribution, and workspace;
main revalidates all four, validates the input with the existing bounded extension-view input
schema, and publishes it as a new context input to that exact guest. Input is replace-latest,
not queued, and is revoked with the contribution context. The guest cannot call this operation,
target another installation, choose a workspace, or turn it into an event subscription. If the
package is absent, disabled, stale, or refuses the bead after its next read, Needs you keeps the
row visible and reports that the target could not be opened.

### SSH connector approval

For an SSH workspace, setup approves `bd` and `gc` independently on the selected remote host.
Each grant follows ADR-051: it binds installation identity, the complete connector declaration,
the exact configured host, the selected absolute executable path, its canonical path produced by
`ProjectHost.realpath`, and configuration. Each command pins the live host-qualified workspace
root and the exact approval. Trusted Settings performs selection, connection, authentication, and
probing. The guest can request only structured arguments for an approved connector; it cannot
connect the host, discover executable paths, run a shell, or reuse a local approval remotely.
Disconnected execution is refused and never replays on reconnect. Unchanged approval survives
explicit package revision actions; a changed declaration, host, or canonical executable target
requires a new trusted decision. This ADR adds no approval rule beyond ADR-051.

### Core and package ownership

Core retains the small typed Beads taxonomy and human-work predicates used by structural
dispatch and Needs you. They are public pure policy, not panel placement or rendering policy;
the extension package consumes the same versioned module when classifying `bd` output. Core
also retains Needs you collection, Gas City attention aggregation used outside the package,
safe native external-URL opening, connector grants, terminal ownership, and contribution
lifecycle.

The package owns Beads sections, counts, filters, evaluation-link derivation, Gas City crew
presentation, and analytics-link derivation. Non-secret analytics inputs must come from bounded
structured `gc` output or explicit package configuration, never the hvir process environment or
raw marker-file reads. Until `gc` exposes those inputs, analytics links are unavailable rather
than served by the old private `gascity:analytics-config` channel.

Evaluation and analytics links require one additional public platform seam: a user-activated
safe-external-URL operation. It accepts only an `https` URL, and only when main itself observed a user activation on the
visible guest surface for that request; a guest-supplied flag never proves activation (ADR-054).
Main applies the existing `isSafeExternalUrl` validation, shows the destination origin in a
trusted confirmation before opening, and opens the system browser. It grants no network read
to the guest and cannot run from the updater. URL construction and domain-specific validation
remain package code; native opening remains core authority.

### Rehearsal capability map

| Rehearsal need | Public owner or explicit gap |
| --- | --- |
| `beads:list` | Approved `bd` `connector.execute` and bounded `connector.output`; parsing and presentation are package-owned. |
| `beads:probe` | Approved `bd` connector status plus a finite probe command; failure stays distinct from an empty store. |
| `gascity:crew` | Approved `gc` connector execution; package parses and joins the bounded structured result. |
| `gascity:probe` | Approved `gc` connector status plus a finite probe command. |
| `gascity:analytics-config` | Gap in `gc` structured output or package configuration, plus the safe-external-URL gap; no replacement hvir domain IPC. |
| `gascity:attention` and `gascity:attention-changed` | Remain core because application attention must exist with no visible extension demand; they are not exposed to the package. |
| `project:watch` | Deliberately replaced by foreground updater refresh and explicit Refresh; no watch capability is added. |
| `bd create` and `bd update` handoff | Existing ADR-058 `terminal.start` with an approved `bd` executable and structured arguments. |
| `gc attach`, reset, peek, and handoff | Existing ADR-058 `terminal.start` with an approved `gc` executable and structured arguments. |
| Attach reuse key | Not provided by ADR-058. The extension opens a fresh explicit command-once terminal for every request; repeat-focus parity is deferred unless a separate terminal-owner decision justifies it. |
| `focusBeadId` | Gap: trusted targeted-view input described above. |
| Rail tab and panel | Existing ADR-050 workspace left-navigation contribution and ADR-052 presentation kit. |
| Evaluation and analytics links | Package-owned derivation plus the safe-external-URL gap described above. |

### Phased child-bead sequence

The following phases are dependency order for independently reviewable child beads, not an
acceptance ledger:

| Phase | Scope | Verification command |
| --- | --- | --- |
| 1. Targeted input | Add the bounded trusted targeted-view-input contract, ownership checks, replace-latest delivery, and Needs you unavailable behavior. | `npm test -- extension-context-owner extension-view-launcher needs-you-navigation` |
| 2. External links | Add visible-gesture-only safe external URL handoff using the existing native URL policy. | `npm test -- extension-guest-owner extension-view-launcher` |
| 3. Package read surface | Add the package, `bd` and `gc` declarations, demand-scoped refresh, taxonomy consumption, Beads sections, crew presentation, and explicit failure states. | `npm test -- extension-connector extension-contribution extension-guest` |
| 4. Commands and navigation | Add terminal handoffs and Needs you focus handling; verify fresh-terminal semantics and local/SSH grant identity. | `npm test -- extension-terminal-handoff extension-connector needs-you-navigation` |
| 5. Link inputs | Add structured `gc` analytics inputs or explicit package configuration and package link rendering; do not restore private domain IPC. | `npm test -- extension-guest extension-connector` |
| 6. Cutover | Remove the built-in Beads/Gas City panel, its private IPC and services, then run the extension, terminal, and remote-workspace smoke scenarios; Needs you coverage stays in `needs-you-navigation` unit tests unless the cutover bead adds a smoke scenario. | `npm run verify && npm run build:smoke && node scripts/run-smoke-scenarios.mts extensions workspace-remote terminal-lifecycle` |

## Consequences

The fork converges on the same isolation, approval, lifecycle, and presentation contracts as
other packages. Beads and Gas City policy can change with the package without adding main IPC.
Local and SSH workspaces follow one host-qualified execution model, and invisible package code
cannot poll.

The replacement depends on two small public platform additions and on a structured source for
non-secret analytics inputs. Until those exist, deep focus and browser links are visibly
unavailable. Session attachment initially loses repeat-focus reuse and always opens a fresh
terminal. Core still knows the minimal Beads human-work taxonomy because Needs you and
structural dispatch require it independently of the package.

## Rejected alternatives

- Keep the built-in panel beside the package: two behavior owners would drift and private IPC
  would remain the easiest path.
- Expose the old Beads and Gas City IPC to guests: domain endpoints bypass connector grants and
  make the public boundary fork-specific.
- Refresh from project file watches: Dolt writes can change the store without the watched file
  signal, so the view could present stale data as current.
- Let the updater run without visible demand: that turns an installed package into a background
  poller and violates ADR-050.
- Give the package host discovery, SSH authentication, filesystem reads, shell execution, or
  native URL access: each collapses a separately owned trust boundary.
- Keep taxonomy, link derivation, attention, and navigation together in either core or the
  package: these responsibilities have different consumers and lifetimes.
