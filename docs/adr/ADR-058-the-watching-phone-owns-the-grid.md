# ADR-058: The watching phone owns the grid

> Lifecycle: Active
> Supersedes: [ADR-050](ADR-050-companion-live-terminal-mirror.md) | partial | A mirror never resizing the PTY, for as long as a Companion page is watching that PTY.
> Supersedes: [ADR-057](ADR-057-companion-mirror-shows-the-desktop-grid-at-every-focus.md) | partial | One fit at every focus state, with the phone drawing the desktop's grid scaled, for the grid a watching page declares.

## Context

ADR-052 gave the phone its own grid while every hvir window was unfocused, and ADR-057 took it
away again after a real device showed the cost: a person saw two fits in one sitting, because
the size changed on every desktop focus transition, and the phone-sized one read back laggily.
ADR-057 kept the fit that was stable, which was the desktop's grid scaled to the phone's width.

A day on the scaled view found what that costs. The desktop's grid is wide and short, so on a
phone it is a small strip of small text with a black band above it, and the band is the part
that matters: there is almost always more session history that could be drawn in that space and
is not. The scaled view is one view, but it is one view of the wrong shape.

Both records were answering the same question with a focus predicate, and focus is the wrong
input. What a person wants from a phone does not change when a laptop lid is opened at a desk
across the room. Blink.sh settles it the other way: the client that is looking at a session sizes
it, the other client draws what it is given, and nothing swaps under either of them while both
are watching.

The remaining cause of the "two modes" symptom was outside hvir and is recorded with the session:
`tmux -L ds-research` ran `window-size latest`, so each window kept the size of whichever client
last touched it. `window-size manual` on that server stops the two modes there, but it is a
setting on one machine, applied by hand, that a new window or a new server loses.

## Decision

### A page that is watching owns the size of what it watches

For as long as a Companion page holds a live mirror, that page's grid is the PTY's size. The page
measures its own terminal area in whole cells of its own fixed font and declares that grid over a
`viewport` verb; main applies it to the PTY, publishes it to every mirror and to the desktop, and
holds it there. Desktop focus is not an input to this anywhere: not in the phone's fit, not in the
lease, not in the supervisor. Away remains what ADR-049 made it, the predicate that admits Push.

Declaring a grid is not typing. A page whose typing is off in Settings still sizes what it reads,
because watching is what earns the size.

### The desktop remembers its own fit and takes it back

While a hold is on, the desktop's fit is recorded rather than applied, and the pane draws the held
grid with a notice naming it. When the hold ends, which is when the mirror ends however it ends,
the PTY goes back to the fit the desktop had at that moment. The hold is held by a token belonging
to the lease that took it, so a stale lease releasing gives nothing back, and a second page taking
the size over keeps it when the page before it lets go. The most recent declaration wins.

### The page keeps drawing whatever size the PTY actually has

The phone never draws a grid it only asked for. Until a geometry frame says the PTY took the grid,
the page draws the size the PTY has, scaled to its width exactly as ADR-057 has it. A declaration
that the desktop could not take is forgotten rather than retried on a timer, and the next settled
layout asks again.

ADR-057's other decisions stand as written: a drag carries every report its distance earned, a
lift with speed flings on, and the mirror keeps the desktop pane's scrollback.

## Consequences

The phone shows one view of a session, at the density the desktop shows, filling the height with
session history rather than a black band, and nothing about it changes when a desktop window gains
or loses focus. The desktop is the view that changes while someone is on the phone, which is what
a person watching from a phone expects and what they cannot see anyway.

A desktop pane showing a held session is narrower than its area for as long as the phone watches,
and says so. Someone at the desk who wants their grid back closes the phone's mirror; the pane
refits within a cycle.

Two phones on one PTY settle on the most recent declaration rather than fighting, and a page that
crashes or drops its stream gives the size back when its lease ends, not when it says so.

The tmux `window-size manual` remedy on the research server is no longer load-bearing for hvir's
own sessions, since the client that owns the grid now sets it explicitly. It stays where it is for
sessions attached outside hvir.

Revisit if a person wants to watch from a phone without touching the desktop's layout at all: that
is a control the person turns on, not another predicate.

## Rejected alternatives

- Keep the focus predicate and pin the grid per session: focus is what makes a person see two
  views of one session, and pinning behind it keeps that. Blink's rule has no predicate to get
  wrong.
- Let the phone pick a size only when the desktop is not showing that session: the desktop pane
  showing it is the case that matters, and the one a person on the sofa cannot check.
- Leave it to tmux `window-size manual`: a setting applied by hand on one server, lost by a new
  window, and absent for a session not under tmux at all.
- Let the page draw its declared grid before the PTY takes it: the phone would render a screen the
  session has not laid out, which is the reflow the scaled view avoids.
