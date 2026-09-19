# ADR-053: The Companion mirror reads back through the emulator's viewport

> Lifecycle: Partially superseded
> Supersedes: [ADR-052](ADR-052-companion-mirror-holds-pty-size-while-away.md) | partial | The page's own scrollback layer drawing above the grid for a shell's mirror, for the emulator's viewport as the one read-back surface.
> Superseded by: [ADR-055](ADR-055-read-back-navigation-is-not-typing.md) | partial | An alternate-screen session stating that it has no history to read back, for a program that keeps its own history and is paged through it.

## Context

ADR-050 put a real emulator on the phone, the one the desktop already trusts, and fed it the
PTY's bytes unchanged. ADR-052 then gave the phone its own grid while the desktop is Away, and
kept one thing from ADR-050 deliberately: a shell session keeps its history column, the phone
shows that column of scrollback above a grid pinned to the bottom, the history is a swipe away,
and the scrollback layer draws above the grid exactly as it did before. That record narrowed
size, not read-back.

The history column is a second surface. The page asks the emulator for its buffer lines, joins
their text, and writes that text into an element above the grid at the grid's cell metrics,
rebuilt a few times a second and capped at a thousand rows. The live screen underneath is drawn
by the emulator's own renderer out of the same buffer. One source, two renderers, and only one
of them is the emulator.

That split is a fidelity problem, and on a phone the fidelity is the feature. Text taken out of
the buffer carries no colour, no bold, no reverse video, and no cursor, so a coloured `ls`, a
`git log --graph`, a diff, or a Claude Code turn reads back in flat grey while the same rows sit
in full colour one row lower. Wide characters and combining marks are the emulator's arithmetic,
and the page redoes that arithmetic to place them. The layer is bounded by a row count the
emulator does not share, so the phone stops reading back at a different place from where the
session actually stops keeping rows.

The alternate screen makes the split worse rather than better. A full-screen program keeps no
scrollback at all, so the column has nothing to draw, and a page that draws an empty box there
tells the person their history is missing rather than that it never existed.

## Decision

### The emulator's own viewport is the read-back, and the page keeps no second text surface

The mirror draws one surface, the emulator's grid. Reading back moves the emulator's viewport
over the scrollback the emulator already holds, and every row the person reads is drawn by the
renderer that draws the live screen, so colour, attributes, wide characters, and theme are exact
by construction rather than by agreement. The page's scrollback layer, its row cap, and its
refresh timer are removed. Fidelity stops being something the page maintains and becomes
something it cannot lose.

### A gesture over the grid moves that viewport under the one shared wheel policy

A finger drag over the grid is the same decision a wheel notch is, and the shared wheel policy
that already decides it for the desktop pane and the mirror alike decides it here: the viewport
owns a normal-screen gesture, a full-screen program receives page keys, and a program tracking
the mouse receives SGR reports. Touch adapts into that policy's event shape rather than growing
a second policy beside it, so the two surfaces cannot disagree about what a gesture means, and
whatever bytes a gesture produces pass the same arming gate as a keystroke.

### The page reads where the viewport is and never what it says

The page asks the emulator for the viewport's position, and that is the only question it asks
about the screen. It reads no cell, no row, and no line of text to decide anything, including
whether to offer a way back to the live edge. Position is not content, so ADR-019's rule that
attention never comes from inspecting the screen, and ADR-051's restatement of it, are
untouched: nothing in this decision raises, clears, or classifies attention, and a person
reading back changes no attention state at all.

### An alternate-screen session states that it has no history to read back

A full-screen program's earlier turns live inside the program, not in the emulator, so there is
no scrollback for a viewport to move over. The mirror says so in words rather than leaving an
empty column standing where history would be, and it offers no read-back affordance that moves
nothing. The condition comes from which screen the emulator is on, a mode flag rather than the
screen's text.

## Consequences

The mirror becomes a continuation of the session's screen instead of a transcript of it. What
the person reads back on the phone is what the desktop pane would show, because it is the same
emulator drawing the same buffer, and the page sheds a whole renderer along with the row cap,
the refresh timer, and the drift they carried.

The costs are real and not all of them are recoverable. On the alternate screen there is no
read-back at all: someone who wants the earlier turns of a full-screen Claude Code session has
to ask the program for them, and the mirror can only say that. Read-back depth becomes the
emulator's scrollback budget of one million bytes per mirror, a byte budget rather than a row
count, so how far a session reaches back depends on what its output weighs and not on how many
lines it wrote. The held position is the emulator's state and does not survive a remount, so a
page that reloads comes back at the live edge. A person can get stuck away from the live edge,
so the mirror carries a control that returns to it, and that control is part of this decision
rather than a later polish.

Revisit this record if the read-back should carry inertia or momentum rather than tracking the
finger, if the phone should own a scrollback depth separate from the emulator's, or if the phone
should page a full-screen program's own history instead of stating that it has none. Each is a
different decision, not an extension of this one.

## Rejected alternatives

- A page-owned span renderer, widening the mirror's seam to carry per-cell colour and attributes
  and rebuilding coalesced `<span>` runs above the grid, which is the shape the present text
  layer would have to grow into: it is a second renderer reimplementing the emulator's drawing
  in DOM, so it drifts from the emulator with every emulator change, and thousands of spans
  rebuilt every eighty milliseconds needs incremental append-only rendering plus a full rebuild
  on every resize before it is even correct.
- A reflowed transcript, using each line's wrapped flag to rejoin logical lines and re-setting
  the text at the phone's width: a shell's scrollback is columnar, so `ls`, `git log --graph`, a
  diff, and every table are destroyed by the reflow that was supposed to make them readable, and
  it makes history a different surface from the live screen directly below it.
- Snapping the view back to the live edge whenever output arrives: it yanks the screen away
  mid-read every time the session writes a byte, which is exactly what the existing wheel policy
  was written to avoid.
- A touch policy separate from the wheel policy: what a gesture means is already decided once in
  the shared wheel policy, and a second policy lets the two surfaces disagree about the same
  gesture on the same screen.
