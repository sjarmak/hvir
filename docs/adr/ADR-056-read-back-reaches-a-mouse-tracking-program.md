# ADR-056: A read-back gesture reaches a program that tracks the mouse

> Lifecycle: Active
> Supersedes: [ADR-054](ADR-054-sticky-terminal-modes-precede-the-replayed-tail.md) | partial | The mouse tracking family left to the window, for a mirror whose gesture the program's own wheel reports answer.
> Supersedes: [ADR-055](ADR-055-read-back-navigation-is-not-typing.md) | partial | The exempt set closed at the two page keys, for the wheel reports the same policy sends a program that tracks the mouse.

## Context

ADR-055 got the phone paging a program that owns its history, and on a real device against
Claude Code under tmux it pages. It still does not read back the way the desktop does. The
desktop moves through that session smoothly and for as far as the program holds; the phone
moves a little and stops.

The session says why:

```
$ tmux -L ds-research show -g mouse
mouse on

$ tmux -L ds-research list-keys -T root | grep -ci ppage
0
```

With `mouse on`, tmux turns mouse tracking on for the PTY. The desktop's emulator watched that
happen, so the shared wheel policy routes a trackpad to SGR wheel reports, tmux hands them to
the pane's program, and the program scrolls itself. The phone's emulator never saw it. The
enable sits where tmux attached, hours outside any retained window, and ADR-054 names the mouse
tracking family as a mode it does not carry. So the phone's policy finds no mouse tracking,
falls through to the alternate screen, and sends `PageUp`, which tmux binds nowhere in its root
table and therefore hands to the program as a keystroke the program barely honours.

Both surfaces make the same decision about the same gesture over the same PTY and reach
different routes, because they hold different beliefs about the session. The gesture is not the
problem and neither is the policy. What the phone knows is.

ADR-054 excluded the family for a reason it stated plainly: carrying it makes the phone's
emulator report mouse tracking, the policy then routes every gesture to SGR reports, and a
disarmed mirror drops those bytes while the policy counts the gesture handled, so read-back
stops working with nothing on the screen to say why. That was true when it was written. ADR-055
then built the thing that answers it: a channel for the bytes a read-back gesture produces,
which the per-mirror arm does not hold and the terminal input record does not see. The
objection was about the arm, and the arm is no longer in the way.

## Decision

### The carried set gains the mouse tracking family, whole

`?1000`, `?1002`, `?1003`, `?1006` and `?1015` join `?1049` and `?47` in the set ADR-054's
scanner carries, under that record's existing rules: the last transition seen, the position it
sits at, emitted only when the window it precedes cannot prove it, and no reset ever emitted
because a fresh emulator starts with tracking off.

Whole, or not at all. `?1006` is the encoding the policy requires before it will synthesize a
report; carry the trackers without it and the phone finds mouse tracking it cannot encode for,
consumes the gesture, sends nothing, and reads back nowhere. That is the silent failure ADR-054
predicted, and it is reached by carrying half this set rather than by carrying all of it. The
family moves together or the set does not move.

### Read-back navigation is what the policy emits for a read-back gesture, on whichever route

ADR-055 defined the exempt set as the complete output of the alternate-screen route. It stays
defined by the policy rather than by a list beside it, and it now covers the mouse route too:
the wheel reports the policy synthesizes, buttons 64 and 65, and nothing else. Those are the
only reports it can produce for a scroll, they are a wheel notch by construction rather than a
press at a position, and a phone gesture carries no modifier that could make them anything
else.

Everything ADR-055 said about these bytes holds for the wider set without change. The owner's
permission gates them. The per-mirror arm does not. They reach the PTY without being recorded
as terminal input, so reading back raises no attention and sends no Push. The set is closed
here rather than in code that can grow it, and a byte outside it is typing.

### The phone routes a gesture on what it knows, and now it knows

Nothing in the policy changes. The phone reaching the same route as the desktop is a
consequence of the preamble telling it the truth about the session, not of a second rule for
touch, and the one thing a mirror needed in order to agree with its desktop was the state it
had been denied.

## Consequences

The phone reads back a mouse-tracking session the way the desktop does, through the program's
own scrolling, because both surfaces now answer the same gesture the same way. That is the
whole point of the record.

The preamble grows from fourteen characters to fifty four, and its bound is a wire bound. A
page holding a bundle built before this change refuses an opened event whose preamble exceeds
what it knows, and ADR-054 already states what that costs: an unrecognised shape is a protocol
error that ends the event stream, so such a page loses the mirror until it reloads. Every
mirror of a mouse-tracking session carries the longer preamble, so this is not a rare path for
an old bundle; it is the common one.

A program that tracks the mouse now receives wheel reports from a mirror nobody armed. That is
a wider door than ADR-055 opened and it is opened deliberately: the bytes are still two buttons
of a scroll gesture, still gated by the owner's permission, and still not typing. The judgement
that a report is a press at a position, which ADR-055 gave as its reason for refusing this, is
wrong for the two buttons the policy actually emits.

The emulator's own viewport stops being the read-back for a normal-screen session that tracks
the mouse, because the policy routes the gesture to the program instead. That is not new
behaviour and it is not this record's doing: the desktop has always worked that way, and the
phone only appeared to differ because it did not know. ADR-053's viewport read-back remains
the path for every session that does not track the mouse.

Main now carries seven modes where it carried two, and that is the boundary ADR-054 drew moving
once. It moves by the same rule: a closed named set of flags and the positions they were seen
at, no screen behind them, no content read. The next mode anyone wants carried is still a
change to a record rather than a detail of one.

Revisit this record if a program's own scrolling proves worse on a phone than the viewport it
replaces, if the exempt set needs a byte that is not a scroll, or if the preamble's growth
forces the bound to become negotiable rather than fixed.

## Rejected alternatives

- Carrying `?1000` and its neighbours without `?1006`: the policy needs the SGR encoding before
  it will synthesize a report, so the phone would find tracking it cannot encode for and consume
  every gesture silently. This is the exact failure ADR-054 named, and it is an argument for
  carrying the family whole rather than against carrying it.
- Keeping page keys and asking the person to bind `PageUp` in tmux: it makes the mirror's
  read-back depend on a configuration file on the host, it is wrong for every other program
  that tracks the mouse, and the desktop needs no such binding because it never sends the key.
- Letting the phone choose its route from what the bytes look like rather than from carried
  mode state: that is a screen model in the page, reached by inference, and it disagrees with
  the desktop exactly when the inference is wrong.
- Exempting every mouse report rather than the two wheel buttons: a press and a drag report act
  on a program at a position, which is not navigation, and the exemption would stop being
  describable as the output of a read-back gesture.
- Teaching the mirror to enter tmux's copy mode directly: it is one program's binding rather
  than a terminal protocol, the mirror has no way to know it is talking to tmux without reading
  the screen, and ADR-053 forbids deciding anything from what the screen says.
