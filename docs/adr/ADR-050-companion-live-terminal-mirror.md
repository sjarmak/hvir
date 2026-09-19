# ADR-050: The Companion mirrors a live hvir terminal and carries its user's keystrokes

> Lifecycle: Partially superseded
> Supersedes: [ADR-049](ADR-049-companion-observer-and-away-push.md) | partial | The exclusion of a terminal screen and terminal input from the Companion, for live hvir-owned terminals under a mirror lease.
> Superseded by: [ADR-051](ADR-051-terminal-notification-prompt-attention.md) | partial | No phone action clearing attention, for a prompt entry on the mirrored terminal.
> Superseded by: [ADR-052](ADR-052-companion-mirror-holds-pty-size-while-away.md) | partial | A mirror never resizing the PTY, for a live mirror lease while the desktop is Away.
> Superseded by: [ADR-054](ADR-054-sticky-terminal-modes-precede-the-replayed-tail.md) | partial | Main not interpreting the bytes it forwards, for a bounded scan of sticky DEC private modes emitted ahead of the replayed tail.

## Context

ADR-049 made the Companion an observer. It lists every session, and for an external session it
reads the transcript, answers the pending interaction, and sends a message through the
supervisor API that owns that session. For a terminal hvir launched itself it shows the row and
nothing more, and it names carrying terminal input from a phone as a separate decision.

That separate decision is now needed, because of how the sessions are actually run. Claude Code
and Codex are started from a shell inside an hvir terminal, and a gas city worker is joined with
`gc session attach` inside an hvir terminal. On the desktop, Interact on such a row borrows the
live terminal pane and gives the whole keyboard. On the phone the same row answers "not
projected", because these sessions have no supervisor API and hvir has nothing structured to
read. A structured path cannot be built for them either: a harness's permission prompt or option
picker exists only on its terminal screen, never in a transcript file. The session that most
needs unblocking from a phone is exactly the one the Companion cannot reach.

The facts already have owners. Every PTY byte, local or SSH, flows through the PTY supervisor's
stream attachment, which fans output out to a set of listeners; the renderer is its only listener
today, admitted through a door gated on the exact renderer owner and generation. Writes go
through the same supervisor under the same gate. The Sessions projection already identifies a
live row by its immutable PTY instance. ADR-017, ADR-026, and ADR-032 forbid hvir composing text
into a PTY on ambient inference and bind every admitted write to an exact PTY instance and
revision. ADR-009 keeps terminal focus as the only clearing rule; ADR-049 keeps Ready and bell
classification in the renderer; ADR-046 keeps every handle that crosses a projection opaque.

## Decision

### A mirror is a second reader of the PTY stream, never a second owner

The PTY supervisor gains one door beside the renderer's: a mirror lease on an exact PTY
instance. A mirror receives the stream's output and geometry and nothing else. It never spawns,
resizes, kills, or transfers a PTY, and it is not a renderer owner: it is bound to the instance,
so it survives a renderer document swap the way the PTY does, and it ends when the PTY exits,
the Companion page closes, pairing is revoked, the application shuts down, or the page selects
another row.

The stream attachment retains a bounded tail of raw output at all times, sized like the existing
renderer replay budget and independent of it, since that replay is consumed the moment the
renderer attaches. A new mirror receives the tail and then live bytes. It also receives the
desktop's current columns and rows and every later change; the phone renders at that geometry,
scaled to fit its width, and never resizes the PTY.

Bytes cross from main to the phone as they are. Main does not interpret them. Emulation happens
on the phone in ghostty-web, the emulator the desktop already trusts (ADR-003), loaded from the
Companion's own asset bundle. The Companion asset allowlist admits the WebAssembly module and the
page's content security policy admits executing it.

### Phone keystrokes are user input to an exact instance, not hvir-composed text

The page writes exact key bytes under its mirror lease. Main writes them through the supervisor
bound to the lease's instance and fails closed if the instance changed, the PTY exited, or the
lease ended. No newline is appended, nothing is composed, and no provider is consulted. That is
the person at the keyboard, the same input the renderer's own pane carries, and it leaves
ADR-017, ADR-026, and ADR-032 untouched: those records govern text hvir composes, and this
decision admits none.

Typing from the phone is an explicit act three times over. Settings must allow it, and the
default is off. A mirror opens with input disabled and the user arms it per mirror. Arming ends
when the page is hidden, the lease ends, or an inactivity bound passes. The page offers the
terminal keys a phone keyboard lacks, such as Enter, Escape, Tab, arrows, and Ctrl-C, as
on-screen controls beside free text entry. Nothing in this decision limits which bytes may be
sent while armed, because parity with the desktop's Interact is the requirement.

### Attention keeps its owner and gains no clearing rule

Main tells the owning renderer that mirror input reached its PTY, id and bytes, and the renderer
records it as terminal input. That keeps ADR-019's arming in the renderer, so a prompt submitted
from the phone still produces the next Ready and the next Push. A phone keystroke does not clear
attention, and viewing a mirror never does. The row leaves the actionable set the way it does on
the desktop when its terminal is unfocused: Working output follows the submission.

### Which rows mirror

Exactly the rows the desktop offers Interact for: live lifecycle, connected host, and a live
PTY. That covers a shell running Claude Code or Codex, a `gc session attach` terminal, and a
terminal on an SSH host alike, because the supervisor sees their bytes the same way. An external
row without an hvir terminal keeps the ADR-049 transcript path. A row that has both offers both.

### Bounds and ownership

One mirror per Companion page, under the page's existing companion demand owner; the existing
page cap bounds the total. Output rides the page's event stream; input rides bounded request
bodies. Mirror bytes are never logged or written to diagnostics. Revocation closes every mirror
with every page. The PTY supervisor owns the tail and the mirror door. The Companion sessions
service owns mirror leases and their lifecycle. The phone page owns its emulator through the
same engine-neutral pane seam the desktop uses. No new process, listener, or setting beyond the
one input permission is introduced.

## Consequences

The Companion reaches the sessions the user actually runs, and a Claude Code permission prompt
or option picker can be answered from a phone through the same terminal the desktop shows. The
desktop model is untouched: one owner per PTY, classification in the renderer, focus as the only
clearing rule.

Every live PTY now carries a bounded output tail in main whether or not a phone is watching. The
phone downloads and runs a second emulator instance. A raw tail replays an imperfect first frame
until the program redraws, and a wide desktop terminal is small on a phone until the user
scales it. Input over request bodies adds latency a socket would not; that is an implementation
choice the decision does not fix, and a socket may replace it later.

Away-time correctness for a prompt submitted from the phone depends on the input notice reaching
a hidden renderer on time, exactly as ADR-049's Ready detection does. That must be verified under
background throttling rather than assumed.

Revisit this record if hvir should mirror a PTY that has no renderer document at all, serve one
terminal to several phones at once, or let the phone resize the PTY. Each is a different
decision, not an extension of this one.

## Rejected alternatives

- Reading the harness's own transcript files (Claude Code's JSONL, Codex's rollout) and writing
  answers into the PTY: permission prompts and option pickers never appear in those files, so
  the read path would be blind to the moment that matters, and the write path would still be
  terminal bytes. Two half-paths, each provider-specific.
- A headless emulator in main publishing screen text: main would interpret the bytes and hold a
  copy of a renderer-owned surface, add an emulator dependency to main, and lose the terminal's
  own scrollback and selection. The phone can run the emulator the desktop already trusts.
- A structured composer only, sending a line and Enter: it cannot drive an option picker, answer
  a permission prompt, or send Escape. That is not the interaction the desktop offers.
- tmux under every session plus SSH from the phone: works today with no hvir change, and remains
  a fine operator fallback. It requires starting every session under tmux, a second app on the
  phone, and it does not compose with the Companion's triage and Push.
- The renderer relaying its screen to main: network-bound work and screen copying in the render
  process against ADR-001 and ADR-014, and it fails while the renderer is hidden or throttled.
- Transferring PTY ownership to the Companion: two authorities over one PTY, and the desktop's
  pane goes dark while the phone holds it.
