# UX walkthroughs

The contributor-only walkthrough runner drives real hvir controls in the smoke build against its
disposable fixture repository. It retains evidence for a product critique; it is not an alternate
test framework or an application feature.

Run the first named journey from the repository root:

```sh
npm run ux:walkthrough -- architecture-live-review
```

On headless Linux, provide the virtual display required by Electron:

```sh
xvfb-run -a npm run ux:walkthrough -- architecture-live-review
```

The command creates a unique directory under `ux-walkthrough-artifacts/`. That directory is
gitignored and survives the smoke fixture cleanup. Its `manifest.json` orders the journey steps
and points to one PNG screenshot and one JSON state note per step. Each note records visible
controls, viewport dimensions, relevant scroll extents, scan timings, and Architecture state. A
failed run leaves its completed steps and an incomplete manifest for diagnosis.

The `architecture-live-review` journey opens Architecture, expands and restores the map, expands a
system, compares two commits, returns to the working tree, observes idle stability, follows one
scripted file edit, pauses, rescans while paused, and prepares an explanation handoff. It scrolls
the Explanation panel into view, captures its prepared state, collapses it to the header for a
second capture, and expands it again. Explanation notes record whether the panel is collapsed,
whether its primary action is present, whether only the header remains, and its current status.
Those actions preserve the regression paths for map geometry, the live-review snapshot loop, the
collapsible Explanation panel, and the Architecture tab closing during a manual scan.

## Agent critique

Give the artifact directory to an agent and require both `impeccable` and `click-path-audit` in
that order. The agent should:

1. Read `manifest.json`, then inspect every state note and screenshot in manifest order.
2. Use `impeccable` to assess visual hierarchy, information density, typography, accessibility,
   control clarity, responsive layout, and empty or loading states visible in the evidence.
3. Use `click-path-audit` to trace the full journey as one state-changing sequence, checking that
   each action produces the expected final UI state and that later actions do not cancel earlier
   ones.
4. Separate runner or fixture failures from product findings and cite the journey step plus the
   artifact filenames for every claim.
5. Draft one bead per distinct user-facing problem with reproduction steps, expected behavior,
   actual behavior, and artifact references.

Review the exact drafts and remove repository paths, fixture source, credentials, or unrelated
screen content before publishing. Creating the beads is an external artifact action and requires
explicit approval after that preview.
