# ADR-057: The Companion mirror shows the desktop's grid whether or not the desktop is Away

> Lifecycle: Active
> Supersedes: [ADR-052](ADR-052-companion-mirror-holds-pty-size-while-away.md) | full | Entire decision.

## Context

ADR-052 let a live mirror resize its PTY to the phone's own grid while every hvir window was
unfocused, on the reasoning that a full-screen program keeps its history inside itself, so a
scaled desktop grid was a short strip with nothing above it and text too small to read. Two
later records answered the first half of that. ADR-055 pages a program that owns its history
from a drag, and ADR-056 routes the drag as the wheel reports a mouse-tracking program asks
for, so the phone reads a Claude Code session under tmux back the way the desktop does, at
whatever size the grid is drawn.

A real device against a real session on 2026-09-19 showed what the second half costs. The
phone has two fits, and a person sees both in one sitting: the desktop's grid scaled to the
phone's width while a desktop window is focused, and the phone's own grid, drawn larger,
whenever the desktop goes Away. The larger one is the worse one. Every focus transition on the
desktop resizes every mirrored PTY, so a full-screen program lays itself out twice for one
glance at the phone, and reading back through it at the phone's grid is laggy, because every
report the finger sends is answered by a redraw of a layout the program never wanted. The
scaled view is the one the person asked to keep: the text is small, but it is the desktop's
screen and it scrolls.

Measured on the live seat the same day (Claude Code 2.1.278, fullscreen, under tmux with
`mouse on`): the program honours 1920 wheel-up reports before its history runs out, honours a
burst of 60 in one write, and scrolls about one row per report. The history is there and
reachable at the desktop's grid. What the phone lacked was not a grid of its own but the
travel a desktop trackpad gets for free. The policy held a drag to five reports per move, as
it holds a wheel notch, and the browser's momentum was forfeited with the touch, so a flick
moved a few rows and stopped, which reads as a hard limit that is not there.

## Decision

### One fit

The phone shows the desktop's grid scaled to its width, and only that, whether or not a
desktop window is focused. A mirror never resizes the PTY: ADR-050's rule stands whole again,
and the desktop's fit controller is the one author of a PTY's size. Away stays what ADR-049
made it, the predicate that admits Push, and decides nothing about layout.

Everything ADR-052 added for the other fit goes with it: the mirror lease's resize verb and
the supervisor's Away door, geometry provenance and the reclaim on focus, the
`pty:mirror-geometry` event and the held-size presentation on the desktop pane, the resize
route and its wire types, and the phone's fit controller. The snapshot's `away` field
remains, for Push.

### A drag travels as far as the finger did

On the SGR route a drag carries every report its distance earned in one event, bounded at a
screen of them rather than at five. A wheel notch is still held to five, because a wheel
makes many events for one gesture and a program scrolling by report keeps up with a few per
event. The reports of one event already travel as one ordered write (ADR-056).

A lift with speed behind it becomes a fling: the adapter that owns the touch keeps moving the
content frame by frame as the same drag, slowing at the rate a scroll view slows, until it
rests or a finger lands on it. The policy hears one gesture from the first touch to the rest,
and banks and drops across it as it did before.

### The mirror holds as much scrollback as the desktop pane

For a session on the normal screen the phone's emulator keeps the same scrollback bound as
the desktop's, so what the desktop can read back the phone can, from the retained tail it was
seeded with onward.

## Consequences

The phone is one view again, and the view is the desktop's screen. A person at the desk and a
person on the sofa see the same grid at the same columns, output arrives at one layout for
both, and a focus transition on the desktop resizes nothing. The text on a wide desktop grid
is small on a phone; the remedy stays a narrower desktop pane, which reaches the phone as an
ordinary geometry frame.

A drag now asks a program for as much scrolling as the finger covered, and a fling asks for
more after the finger is gone. A program that scrolls slowly per report takes longer to
settle after a long flick; the reports still arrive in order, and a finger landing on the
grid stops the fling where it is.

The PTY has one author of its size again, and the supervisor carries no provenance beside
geometry. Two phones on one PTY no longer fight over it.

Revisit if a phone-sized grid is wanted on purpose, as a control the person turns on and
gives back, rather than as a side effect of where the desktop's focus is.

## Rejected alternatives

- Keep ADR-052's rule and fix the lag: the lag is the program laying out for a grid nobody at
  the desktop wanted, twice per glance. The scaled view the person asked to keep never had it.
- The Away grid as an opt-in on the phone: a control on a page that was reduced to one view,
  for a fit that lost to the scaled one on a real device. If it is ever wanted it is a new
  decision, not a switch on this one.
- Raise the five-report cap for every gesture: a wheel notch is many events per gesture
  already, so five per event is the right bound for it and the wrong one for a finger.
