# ADR-052: The Companion mirror holds the PTY's size while the desktop is Away

> Lifecycle: Active
> Supersedes: [ADR-050](ADR-050-companion-live-terminal-mirror.md) | partial | A mirror never resizing the PTY, for a live mirror lease while the desktop is Away.

## Context

ADR-050 made the phone a second reader of a live PTY. It receives the desktop's columns and
rows, renders at that geometry scaled to fit its width, and never resizes the PTY. For a shell
that rule works: the phone shows a column of scrollback above a grid pinned to the bottom, and the
history is a swipe away. It fails for the session the Companion exists to reach. Claude Code
started with `"tui": "fullscreen"` in the user's settings enters the alternate screen (CSI
?1049h, verified 2026-09-18 by spawning `claude` in a PTY and reading the sequence), and so does
every full-screen TUI. On the alternate screen the emulator keeps no scrollback, because the
program redraws its whole grid on every turn and the conversation history exists only inside
the program. Scaled to a phone's width, a wide desktop grid becomes a short strip pinned at the
bottom of the phone with black above it, nothing to scroll into, and text too small to read. The
phone is showing the desktop's terminal when what it needs is a terminal of its own.

Blink.sh has no such problem because it is the terminal: the PTY is sized to the phone. tmux
meets the same two-client question, one window shown at two sizes, and answers it with
`window-size`, choosing the smallest, the largest, the latest, or a manual size. Both point at
the same fact. A full-screen program lays out for exactly one size, so one client has to own it.

hvir already has the signal that names that client. ADR-049 defined Away as every hvir window
unfocused, computed by `ActionableAttentionSet.away()` from the focus the window manager reports
per renderer owner, and made it the one predicate that admits Push. The PTY supervisor records
geometry per PTY and changes it only through its renderer-owned resize, gated on the exact owner
and generation; the desktop's fit controller drives that call from the pane's measured size;
mirrors read geometry once at attach and receive every later change. A mirror lease has no resize.

## Decision

### The phone owns the PTY's size while the desktop is Away

While `ActionableAttentionSet.away()` is true, a live mirror lease may resize its PTY to the
phone's own grid, and the supervisor records that geometry as the PTY's current size with the
mirror as its provenance. A full-screen program then lays out for the phone and fills it edge to
edge, and the phone renders its own grid unscaled. This is the one narrowing of ADR-050's rule.
A mirror still never spawns, kills, or transfers a PTY; it never resizes while any desktop window
is focused; and it never resizes after its lease ended or for a changed instance. Those requests
fail closed exactly as the mirror's writes do.

Away is the whole rule. The user learns nothing new: Away already means the phone is where the
badge goes (ADR-049), and now it means the phone is the terminal.

### The desktop reclaims on focus

When any hvir window gains focus the desktop is no longer Away and takes the size back. Its fit
controller resizes the PTY to the pane's measured grid within one fit cycle, main publishes the
new geometry to every mirror as it does today, and the phone returns to the scaled-mirror view of
ADR-050 for as long as the desktop stays focused. Nothing is negotiated between the two: a
desktop resize is accepted whenever the desktop is focused, and a mirror's is refused. The
renderer learns the PTY's current geometry and its provenance from main, as mirrors already do,
so the pane can present a size it did not choose.

### Defaults

While the phone holds the size, the desktop pane draws the grid at the phone's dimensions in the
top-left of its pane, leaves the remainder blank, and shows a one-line notice saying that a phone
holds the size, as tmux marks a client smaller than the window. The pane neither scales nor
crops nor refits that grid; fitting resumes when the desktop reclaims.

The phone uses a fixed readable font and derives its columns and rows from the terminal area that
font leaves it, recomputed on orientation change and when the soft keyboard appears or leaves,
and each recomputation is a resize request while Away. When two phones hold mirrors on the same
PTY, the most recent resize wins. A full-screen program can honor only one size, and the phone
that just changed shape is the one being looked at.

### What does not change

A shell session keeps its history column. The phone emulates at its own size and the scrollback
layer draws above the grid exactly as it does under ADR-050, so nothing about a shell's mirror
moves. Geometry provenance is a supervisor fact and never an attention fact: the actionable set
and its classification (ADR-019, ADR-051) are untouched, and holding the size clears nothing.
The desktop remains the PTY's only owner. A mirror that holds the size is a second reader with
one more admitted verb, and the door for that verb sits beside the renderer's in the supervisor,
under the same instance and lease checks as the mirror's write.

## Consequences

A fullscreen Claude Code session, or any alternate-screen program, becomes usable from a phone.
The person opens the mirror away from the desk, the program fills the phone at a readable size,
and its option pickers and permission prompts can be read and answered as they are. Sitting at
the desk with the phone beside the keyboard changes nothing, because a focused desktop holds the
size.

The PTY's size now has two authors and a rule choosing between them. The supervisor carries
provenance beside geometry, and the renderer gains a presentation it never needed before, a held
size it does not fit. Every focus transition on the desktop is also a resize of every PTY a phone
is mirroring, so a full-screen program redraws when the person returns to the desk and the phone
snaps from filled to scaled at the same moment; a program that handles SIGWINCH badly will show
it on both surfaces. Two phones on one PTY will fight if both are turned at once. The rule makes
that outcome deterministic, not pleasant.

The Away predicate now decides layout as well as Push. A stale focus record would either strand
the desktop at the phone's size or refuse the phone, so the rule must be verified with a real
window losing and regaining focus rather than assumed.

Revisit this record if the desktop should be able to hand the size to the phone while it is
focused, if the phone should page a full-screen program instead of resizing it, or if a mirror
should hold the size for a PTY that has no renderer document at all. Each is a different
decision, not an extension of this one.

## Rejected alternatives

- The phone owns the size whenever a mirror is open, regardless of focus (tmux's `latest`):
  squashes the desktop pane to a phone's grid while the person sits at the desk with the phone
  beside them, which is the common case for someone glancing at the phone between turns.
- An explicit "take the size" control on the phone: one more control on a page that was just
  reduced to a single view, a tap on every visit, and a state the person must remember to give
  back. Away already says what the control would ask.
- Scaling the desktop's grid to the phone's height and panning sideways (the removed fill-height
  view): readable rows, but a full-screen program laid out for a wide desktop pans several
  screens across, and the conversation history stays unreachable because the alternate screen
  has none.
- Resizing nothing and paging the program with PageUp and PageDown from a drag: a full-screen
  program's history is not in the emulator, so paging asks the program to scroll, which only some
  do, and the black area above the strip remains.
