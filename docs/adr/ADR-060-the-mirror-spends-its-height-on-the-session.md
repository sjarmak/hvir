# ADR-060: The mirror spends its height on the session

> Lifecycle: Active
> Supersedes: [ADR-055](ADR-055-read-back-navigation-is-not-typing.md) | partial | The standing line the mirror showed for a program that keeps its own history, for the rows of the session that line stood on.

## Context

ADR-055 gave a full-screen program a real read-back, a drag that pages it through its own
history, and had the mirror say so in a line above the grid. The line was written when the
alternative was ADR-053's claim that such a session had no history at all, and next to that claim
it was plainly better.

What it costs is a row of the phone's screen, permanently, for every frame the program draws. On
a phone that is most of the session's time: a full-screen program is what a phone is usually
watching, and the mirror's whole purpose after ADR-058 and ADR-059 is that the height goes to the
session. The line is also a fact about the gesture rather than about the session, and it repeats
that fact continuously to someone who has already made the gesture.

## Decision

### Nothing stands permanently over the grid

The mirror shows the alternate screen with no notice above it. The drag still pages the program
through its own history, unchanged (ADR-055), and the way back to the newest output is still
offered on the normal screen, where it means something. What the mirror says is what has just
happened, a session that ended or a pane that failed, not what is continuously true.

The page still hears which screen the emulator is on, because it is what decides whether the way
back is offered at all: a viewport that cannot move is not offered a trip home.

## Consequences

A phone watching a full-screen program shows one more row of it, and shows the same grid whatever
screen the program is on, so nothing about the layout moves when a program takes the alternate
screen.

The paging gesture is now undiscoverable from the screen. It is the same gesture as every other
read-back, the one a finger makes anyway, so it is found by using it; the operator runbook is
where it is written down.

Revisit if the gesture proves undiscoverable in practice, in which case it wants a cue that costs
nothing standing, shown once or on the gesture rather than for the life of the program.

## Rejected alternatives

- Show the line once and fade it: a phone's mirror is watched for hours and re-entered often, so
  "once" is many times, and each one moves the grid.
- Put it in the header beside the title: the header is one line with the way back and the text
  size on it, and the notice would push one of them off a phone's width.
- Keep it: a permanent sentence about a gesture is not worth a permanent row of the session.
