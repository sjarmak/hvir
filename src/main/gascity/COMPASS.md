---
compass_area: "gascity — main-owned session and external-attention projection"
area_path: "src/main/gascity/"
generated: "2026-11-11"
sources_hash: "sha256-16:b28be16acc7ca91f"
sources:
  - gascity-owner.ts
  - gascity-reader.ts
  - gascity-city-sessions.ts
  - gascity-crew.ts
  - gascity-parse.ts
  - city-event-streams.ts
  - city-attention.ts
  - supervisor-access.ts
---

# Compass: Gas City session and attention projection

## Purpose

This area turns connected-host Gas City state into two core hvir capabilities: the global Sessions projection and external attention that participates in application badges. It does not own a visible Beads or crew panel. The Beads extension package owns that workspace UI and reaches Gas City only through approved connector capabilities.

The main process retains this area because session identity, project placement, host connection authority, event-stream lifetime, and application attention are trusted lifecycle responsibilities. Neither a package guest nor the renderer may own them.

## Key files and entry points

- `gascity-owner.ts` is the composition boundary. `ownGasCityRuntime` assembles one shared reader, supervisor access, event-stream owner, Sessions source, and attention projection.
- `gascity-reader.ts` is the bounded `gc` read path behind `ProjectHost`. Its caches share expensive host reads without turning a failed read into a durable empty answer.
- `city-event-streams.ts` owns one supervisor event stream per connected host with an open project. It publishes stale facts on transport loss instead of silently withdrawing prior attention.
- `city-attention.ts` places pending interactions onto hvir workspaces and emits revisioned external-attention snapshots.
- `gascity-city-sessions.ts` derives host session facts for the Sessions application. `gascity-crew.ts` remains its structural tiering input; it is not a renderer-panel model.
- `supervisor-access.ts` resolves a connected host and city name to the narrow supervisor client surface used by Sessions, attention, and Companion.
- `gascity-parse.ts` normalizes untrusted `gc` output. Unknown or incomplete records stay explicit rather than being guessed from names.

## How it connects

- `src/main/index.ts` owns one `GasCityRuntime` for the application lifetime and publishes external attention over app IPC.
- `src/main/sessions/` consumes observation, event, transcript, and attach capabilities without holding supervisor credentials or foreign identifiers in the renderer.
- `src/main/attention/` combines Gas City attention with renderer-owned actionable attention for the application badge.
- `src/main/companion/` reads the same pending-interaction facts for companion status and responses.
- `src/main/rail-services.ts` uses the shared reader only to determine which Needs You candidate roots belong to a city. It does not expose Gas City IPC.
- All subprocess and remote work crosses `ProjectHost`; supervisor traffic is limited to hosts hvir already connected.

## Gotchas and non-obvious constraints

- A hidden Sessions view must not stop external attention. Event streams follow open projects, not view demand, because a worker can start waiting while no session UI is visible.
- Transport loss is uncertainty, not resolution. Preserve the last nonzero pending count as stale with a reason; dropping it would tell the person that nobody is waiting.
- Stream callbacks are generation-checked. A close or event from a replaced client must never overwrite the replacement stream's facts.
- There is one stream per host, even when several projects on that host are open. City resolution may improve a held host entry, but project count must not multiply connections.
- Supervisor clients are created only for already-connected hosts. Observing an external session must never dial a disconnected SSH host.
- Failed city-name reads are not cached. A transient supervisor failure should be retried on the next selection instead of becoming a false city-unknown verdict for the cache lifetime.
- Host-wide `gc` caches are attributed to the city they described. Invalidating a workspace also invalidates host reads so a city switch cannot reuse another city's session/config facts.
- Session placement is structural. Paths, rig records, configured identities, and projected tier fields are evidence; `*-pl`, `mayor`, and other naming conventions are not.
- City scope is exact root equality. Containment would classify nested rigs as the city and leak unrelated sessions across project boundaries.
- A rig lead can be declared at city scope and acquire its rig through the referenced agent. Name-only matching loses that association and can promote or demote the wrong session.
- Path-shaped aliases are identity evidence, not display text or safe command arguments. Main resolves attach targets and the shared command builder quotes the selected target.

## Failure modes seen here

- Treating `.gc` as the city marker made every registered rig look like the orchestration workspace because each rig owns a `.gc` directory.
- Associating sessions only by `work_dir` lost pooled workers whose worktrees live outside the rig root.
- Treating an identity with no explicit rig as the city lead promoted project leads that inherit their rig through agent configuration.
- Reusing a stale stream callback after reconnect replaced current facts until generation checks were added.
- Clearing pending facts on a stream failure hid a person-facing wait; the current stale-count contract exists to prevent that regression.
