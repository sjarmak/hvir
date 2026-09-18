# Renderer responsiveness diagnostic evaluation

> Historical evaluation: ADR-025 supersedes the recommendation below and removes this
> experiment. This document records the evidence boundary that was evaluated; it does not
> describe a current hvir capability.

This document records the bounded experiment authorized by ADR-016. It is a diagnostic
contract and product recommendation, not a responsiveness SLA: Chromium Long Tasks are
low-confidence evidence that the renderer main thread was occupied, not proof that hvir caused
a user-visible failure.

## Detector contract

| Concern | Contract |
| --- | --- |
| Owner and process | The renderer-owned detector observes Chromium timing entries. The main-owned `ResponsivenessDiagnosticSessions` coordinator qualifies the exact renderer generation, bounds the run, aggregates evidence, and owns deletion. |
| Modes | Available only when `app.isPackaged` is false. It starts only from the visible **Start responsiveness diagnostics** action. Ordinary packaged use does not expose or run it. |
| Preconditions | The pinned Electron 43 / Chromium runtime must expose `PerformanceObserver` and the `longtask` entry type. Event Timing is optional correlation evidence. Missing or changed APIs leave a visible unavailable state or stop the run as `api-unavailable`; they do not affect product behavior. |
| Observation and threshold | A visible renderer task lasting at least 100 ms is eligible after a one-second session warmup. Event Timing entries are used only to classify an overlapping interval as `input-paint-delay`; event names and input values are never read or retained. |
| Severity and product effect | Every retained episode is informational, low-confidence diagnostic evidence. No episode opens workbench health, raises ADR-009 attention, reloads a renderer, or changes terminal behavior. |
| Episode aggregation | Renderer entries separated by at most one second settle into one observation. Main combines observations into at most one aggregate per 30-second owner/session window. A conservative merge becomes `unattributed` if any contributing observation lacks input/paint correlation. |
| Deduplication and resolution | A main window emits on 30-second rollover or on `user-stop`, `timeout`, `backgrounded`, or `api-unavailable`. Renderer rollover revokes the run and deletes its evidence instead of emitting an immediately ownerless record. There is no automatic recovery. Repeated Stop/Delete is harmless, and a new run deletes the prior retained run. |
| Safe schema | A stored aggregate contains only the renderer generation, opaque session/correlation IDs, count, saturated dropped count, timing bucket, classification, confounder enum, first/last ISO times, and resolution. It contains no task attribution, stack, URL, path, DOM, selector, text, input type/value, terminal data, or screenshot. |
| Rate and size | The preload path shares #89's four-observations-per-second token bucket, burst 16, queue 64, and batch 16. The main run accepts at most 512 observations and 30 aggregates over 15 minutes. Stored aggregates are at most 512 bytes and arrive at most once per 30 seconds; overload drops evidence rather than delaying the renderer. Session evidence remains memory-only until the user explicitly creates a temporary reviewed report, so Delete removes the complete run. |
| Runtime cost | The detector installs one Long Tasks observer, optionally one Event Timing observer, one visibility listener, and a settle timer only while active. It performs no filesystem, DOM traversal, forced layout, continuous sampling, or synchronous main-process round trip. Stop, timeout, backgrounding, API loss, renderer rollover, and Delete disconnect observers and timers. |
| Test altitude | Pure tests own thresholding, grouping, conservative classification, queue/rate/capacity, schema rejection, timeout, deletion, and late-generation behavior. The production-composed Electron workflow owns real Long Tasks fault injection and exact report output. The #72 capacity scenario compares disabled and active 15-second phases under 12 terminals and reports CPU, memory, event count, frame p99/max, and click p95/max on Linux and macOS ARM64. |

## Confounders and omissions

- Startup entries during the first second of a run are omitted. This is session warmup, not an
  attempt to infer application startup completion.
- A hidden/backgrounded document ends the run and records that resolution; it does not retain
  throttled background entries.
- Sleep produces no synthetic episode. A run that crosses its 15-minute wall-clock bound times
  out on resume; otherwise later unattributed entries remain explicitly confounded.
- DevTools, garbage collection, OS scheduling, and other runtime contention cannot be reliably
  separated with the safe APIs used here. Uncorrelated work is therefore classified
  `unattributed` with `runtime-or-environment`, never blamed on hvir.
- Event Timing is incomplete: programmatic work, unsupported event types, compositor work, GPU
  stalls, short repeated tasks, and delays outside the renderer main thread can be missed. An
  overlapping event can also be coincidental. These are accepted false negatives and false
  positives for an opt-in diagnostic aid.

## Evaluation and recommendation

The experiment answers a narrow question: “During a user-requested diagnostic window, did the
visible renderer accumulate coarse main-thread occupancy that is useful beside other reviewed
evidence?” The deterministic Electron fixture proves the pinned runtime can produce, group,
preview, copy, and delete such evidence without changing health. The permanent capacity
comparison keeps the observer inside #72's owning performance evidence instead of inventing a
parallel benchmark. Hosted runs label the disabled/active comparison as machine-dependent
evidence; the same budgets become blocking only through the documented controlled-machine
`npm run performance:capacity` command.

Retain this detector as opt-in development diagnostics. Promote no Long Tasks-derived signal to
always-on packaged health. Even input/paint overlap does not identify the cause, and the added
confidence is insufficient to justify persistent instrumentation or a user-facing fault verdict.
No promotion issue is warranted from this evaluation. Reconsider only if a separately aligned
problem identifies a higher-confidence production event and the Linux/macOS capacity evidence
continues to meet ADR-016's cost budgets.

## Ready detection while Away (2026-09-17)

ADR-049 (Companion as away-time observer) makes away-time correctness depend on a hidden or
unfocused renderer still classifying Ready on time, and its Consequences require that this be
verified under Chromium background throttling rather than assumed. The `attention-away-throttling`
Electron smoke group (`src/main/smoke/attention-away-throttling.ts`) measures it: it launches one
Bare Shell, arms the renderer with Enter while the window is focused, puts the window in each
away state, waits a hold, has main write one line so the shell prints a final burst and prompt,
and records the time from the last PTY output main saw to the moment the Ready entry entered
main's actionable set. The budget is the renderer quiet period (`idleThresholdMs`, 4000 ms by
default) plus 2000 ms of slack, so 6000 ms. The group also requires that main's Away predicate is
true when Ready arrives and that the terminal never enters the set while a window is focused.

Measured on 2026-09-17 under `xvfb-run -a` on the shared Linux build machine, with the default
window policy (`backgroundThrottling` unset, so Chromium's default of true):

| State | Hold while away | Quiet to Ready | Renderer state at Ready | Run |
| --- | --- | --- | --- | --- |
| visible, unfocused (`win.blur()`) | 1000 ms | 4011 ms, 4003 ms, 4004 ms | visible, `hasFocus()` false | 1, 2, long |
| hidden (`win.hide()`) | 1000 ms | 4582 ms, 4572 ms | `visibilityState` hidden | 1, 2 |
| hidden (`win.hide()`) | 320000 ms | 5164 ms | `visibilityState` hidden | long |
| minimized (`win.minimize()`) | 1000 ms | 4003 ms | visible, `hasFocus()` false | 2, long |

Run 1 is the first `node scripts/run-smoke-scenarios.mts attention-away-throttling` invocation;
it recorded the first two rows and then failed in the minimized state because the burst was still
shell-timed and fired while the display was still deciding whether to honor the minimize. The
scenario was changed so main triggers the burst only after the state settles; run 2 (the same
command, 22685 ms wall clock) passed all three states. The long run is one
`HVIR_SMOKE_AWAY_HIDDEN_HOLD_MS=320000 HVIR_SMOKE_SCENARIO=attention-away-throttling xvfb-run -a bash scripts/run-smoke.sh`
invocation that keeps the window hidden for 320 s before the burst, past Chromium's five-minute
threshold for intensive wake-up throttling.

Environment caveats. Xvfb runs without a window manager, so `win.minimize()` is not honored
(`win.isMinimized()` stays false and the document stays visible); the scenario reports
`state not honored by the display, blurred instead` and measures the minimized row as a second
unfocused-visible case. On a desktop with a window manager the minimized row is expected to behave
like the hidden row, which is the throttled case measured here. Timings include IPC delivery and a
25 ms main-side poll for the state probes, and the hidden rows show the 1 Hz timer alignment
Chromium applies to hidden pages (about 0.6 s over the 4 s quiet period after 1 s hidden, about
1.2 s over after 320 s hidden). The Ready timer is a single `setTimeout` scheduled from the PTY
output handler, not a chained timer, so intensive throttling (one wake-up per minute for chained
timers) did not apply even after five minutes hidden.

Decision: keep Electron's default `backgroundThrottling` (true) in
`src/main/window/window-policy.ts`. Every measured state reached main within the 6000 ms budget,
including the five-minute hidden case, so the hidden renderer classifies Ready on time and ADR-049's
away-time channel can rely on it without spending the CPU that an unthrottled hidden renderer
would cost. Revisit if `idleThresholdMs` is lowered below the 1 Hz alignment headroom, if the Ready
timer becomes a chained or nested timer, or if a desktop measurement with an honored minimize
exceeds the budget; `npm run smoke` now carries the group, and the hold knob supports a one-off
long-hidden re-measurement.
