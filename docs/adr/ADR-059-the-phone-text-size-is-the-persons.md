# ADR-059: The phone's text size is the person's

> Lifecycle: Active
> Supersedes: [ADR-058](ADR-058-the-watching-phone-owns-the-grid.md) | partial | One fixed readable mirror font, for a size the person sets on the device.

## Context

ADR-058 made the watching phone's own grid the PTY's size, derived from its area and one cell
of a font fixed at fifteen pixels. On a real device that grid is about forty columns by thirty
rows. The black band is gone and the view no longer changes under a desktop focus, but the
session is still shown through a small window: forty columns wraps ordinary terminal output,
and a desktop at the same moment is showing three times the text.

Fifteen pixels was picked as "readable", and the number is the whole result: the cell is the
divisor, so the font alone decides how much of a session a phone holds. Nothing in the code can
tell how small is readable, because that is a property of the eyes, the device's pixel density
and how far away it is held. A phone at three device pixels per CSS pixel draws a nine-pixel
font at twenty-seven real pixels.

## Decision

### The size is set on the device, and remembered there

The mirror draws at a size the person steps up and down from the phone itself, in whole pixels
along a fixed ladder, and the choice is stored on that device. Nothing about the size travels to
the desktop or to main: main learns only the grid, through the same `viewport` verb ADR-058
gave it, and cannot tell a phone that stepped its text from a phone that was rotated.

The default is ten pixels rather than fifteen. A phone's width holds about sixty columns there,
which is a session read rather than a session peeked at, and every step of the ladder is one tap
away for eyes that want otherwise.

### A new size is a new grid, asked for the same way as any other

The size changes the cell, and the cell is what the page divides its area by, so a step re-derives
the grid and declares it exactly as a settled layout change does: the pane remeasures, the view
rescales against the grid the PTY still has, and the fit asks once. The page draws the new grid
only when a geometry frame says the PTY took it (ADR-058), so a hold the desktop refuses leaves
smaller text over the scaled column and nothing else changes.

### The control sits on the mirror

Two steps beside the title, not a settings screen: what they change is on the screen behind them,
and a density is judged by looking at it. The control is beside the way back and the transcript,
takes no height from the terminal area, and is there whether or not typing is armed, because
reading is what it serves.

## Consequences

A phone shows about sixty columns of a session by default and as much as its owner's eyes allow,
and the session is held at that grid for as long as the page watches it. A desktop showing the
same session is narrower while that lasts, which is ADR-058's trade and is unchanged here.

The stored size is per device and per browser, so a second phone starts at the default, and a
device that refuses storage keeps its choice only for the visit.

Steps finer than a pixel are not offered: the emulator measures its own cell, and a fractional
step moves the derived grid by less than a column on a phone's width.

Revisit if the desktop's own typography should follow the phone's, which it deliberately does not:
the two screens are read at different distances by different eyes.

## Rejected alternatives

- Keep one fixed size and make it smaller: the same guess with a different number, wrong for
  someone else's eyes, and unfixable from the device where it is wrong.
- Put the size in Settings beside typing: a density is judged against the text it renders, and a
  screen away from that text is a screen that has to be walked back and forth.
- Scale the drawn grid down instead of shrinking the font: that is what ADR-057 did, and it draws
  the desktop's shape rather than more of the session.
- Pick a size from the device's pixel density: density does not say how far away a phone is held
  or how well its owner sees, and a wrong automatic choice is harder to overrule than a default.
