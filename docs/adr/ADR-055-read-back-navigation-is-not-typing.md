# ADR-055: Read-back navigation reaches a mirrored program without being typing

> Lifecycle: Active
> Supersedes: [ADR-050](ADR-050-companion-live-terminal-mirror.md) | partial | The per-mirror arm gating every byte and mirror input being recorded as terminal input, for the page keys a read-back gesture emits to a program that owns its history.
> Supersedes: [ADR-053](ADR-053-companion-mirror-reads-back-through-emulator-viewport.md) | partial | An alternate-screen session stating that it has no history to read back, for a program that keeps its own history and is paged through it.

## Context

ADR-053 made the emulator's viewport the one read-back surface and drew a boundary at the
alternate screen: a full-screen program keeps no scrollback, so there is nothing for a viewport
to move over, and the mirror says so rather than offering an affordance that moves nothing. The
sentence it wrote for that case claims the session has no history.

That claim is false for the session the Companion exists to reach. Claude Code runs on the
alternate screen, and it is commonly run inside tmux, which holds a full history of its own. So
do a pager, a shell under tmux, and anything else that keeps its scrollback inside the program
rather than in the emulator. What is true is narrower than what was written: the emulator has no
scrollback, and the program may still have history. Read back on a phone against a real session
under tmux, the mirror states there is none, and a drag moves nothing.

The mechanism for reading that history already exists and is already shared. The one wheel
policy of ADR-053 routes a gesture over an alternate-screen program to `PageUp` and `PageDown`,
and that is how the desktop pane scrolls exactly this session: tmux receives the key, redraws
with older content, and the mirror shows the redraw. It is why the phone's view moves when the
desktop scrolls and never on its own. The policy already decides the phone's gesture the same
way. What stops the phone is what happens to the bytes after the policy decides.

Two things stop them, and they are separate. The first is the arming gate: page keys from a
gesture are input bytes, so a mirror whose per-mirror arm has lapsed drops them, which is
ADR-050's rule that nothing is sent from a disarmed mirror. The second is quieter and worse.
ADR-050 has main tell the owning renderer that mirror input reached its PTY and the renderer
record it as terminal input, which is what keeps ADR-019's arming in the renderer so a prompt
submitted from the phone still produces the next Ready and the next Push. Send page keys through
that path and reading back on a phone raises attention and pushes a notification about the
person's own scrolling.

## Decision

### The owner's permission is the boundary for read-back navigation, and the per-mirror arm is not

ADR-050 made typing from the phone an explicit act three times over: the setting must allow it,
the default is off, and a mirror opens disabled and is armed per mirror. Read-back navigation
keeps the first two and drops the third. It is sent when the owner's mirror input permission is
on, including after the per-mirror arm has lapsed, and it is never sent when that permission is
off.

The arm and the permission answer different questions. The permission is the owner deciding that
this desktop's terminals may be driven from a phone at all. The arm exists so that a phone left
unlocked in a pocket, or a page left open on a table, cannot type into a live session by
accident, which is why it ends on hide, on lease end, and on an inactivity bound. A drag a person
is making with a finger on a screen they are looking at is not that risk: the gesture is the
evidence of intent, it is continuous rather than latent, and it expires with the finger. Making
read-back wait on the arm means the common act on a phone, looking at what happened, requires
the ceremony built for the rare one.

Nothing else moves. Typing from the phone still requires the arm, and every byte outside the
exempt set is refused on a disarmed mirror exactly as before.

### The exempt set is closed at the page keys a read-back gesture emits

`PageUp` and `PageDown`, and nothing else. They are the complete output of the shared wheel
policy's alternate-screen route, so the exemption is defined by that route rather than by a list
that can drift from it. The policy's other two routes are unchanged: a normal-screen gesture
moves the viewport and sends no bytes at all, and a program tracking the mouse is outside this
record, because SGR reports carry a position and a button and are not navigation.

This set does not grow by implementation. A byte that is not one of those two is typing, and
admitting another one is a change to this record.

### Read-back navigation reaches the PTY without being recorded as terminal input

The bytes are written to the PTY through the same lease and the same supervisor as any mirror
write, and they are excluded from the input record that main sends the owning renderer. The
renderer never sees them, so ADR-019's arming does not fire, no Ready follows, and no Push is
sent. This is the distinction the mirror already draws for the phone's resize under ADR-052:
resizing reaches the PTY and is not input, so the typing permission does not gate it. Read-back
navigation reaches the PTY and is not input either, so it does not arm attention.

The exclusion is a property of the write, decided where the gesture is known, and it travels
with the write rather than being inferred later from the bytes. Main does not classify the
content of what it forwards, which is the boundary ADR-054 narrowed once and this record does not
narrow again: the phone says which kind of write this is, and the closed set above bounds what
that claim can admit.

### A program that owns its history is read back by paging it, and the mirror says that

ADR-053's decision that an alternate-screen session states it has no history is replaced. The
emulator's viewport stays the read-back for a normal-screen session, unchanged. For a program on
the alternate screen the mirror offers the same drag, sends the page keys, and says what is true:
the program keeps its own history and a drag pages through it. It no longer claims there is none,
and it no longer asks the person to arm anything to read.

## Consequences

The session the Companion was built for can be read back from a phone. That is the whole point of
the record, and it was not true before it.

Paging a program's own history is not private to the phone. It is the same program with one
screen, so the desktop's view moves with the phone's. Emulator-viewport read-back does not do
that, because the viewport is the phone's own. Two read-back mechanisms now behave differently in
a way a person will notice, and the difference is inherent: history the program owns can only be
read by asking the program, and the program has one answer for everyone watching.

A program is free to bind `PageUp` and `PageDown` to something other than scrolling, and a
read-back gesture on the phone will then do that instead. This record admits it, because it is
exactly the bet the desktop's wheel policy already makes on the same keys for the same program,
and parity with the desktop is the requirement rather than a guess about what is safest.

A lapsed arm no longer means a mirror sends nothing. The invariant becomes narrower and has to be
read as it is written: a disarmed mirror sends no typing, and the closed set above is not typing.
Anything that widens that set widens what an unattended page can send, which is why the set is
named here and not in code that can grow it.

Revisit this record if a gesture needs to reach a program tracking the mouse, if the phone should
offer read-back navigation while the owner's permission is off, or if the desktop should be able
to hold its own view while a phone pages the program. Each is a different decision, not an
extension of this one.

## Rejected alternatives

- Requiring the per-mirror arm for read-back navigation: it makes reading conditional on a
  permission built to stop unattended typing, so the act a phone exists for carries the ceremony
  designed for the act it rarely performs, and the notice would have to teach arming before a
  person can read what already happened.
- Giving the page its own scrollback for alternate-screen sessions: this is the surface ADR-053
  removed, it cannot hold what the program never wrote to the emulator, and it would manufacture
  a history the session does not have rather than reach the one it does.
- Keeping ADR-053's notice and telling the person to ask the program: the desktop does not ask,
  it pages, and the mirror's own wheel policy already knows how.
- Recording the page keys as terminal input and suppressing the resulting attention downstream:
  it puts a special case inside ADR-019's arming, where every other attention source would have
  to know about read-back, instead of keeping the one distinction at the write that already
  knows what it is.
- Exempting everything the wheel policy emits, including SGR mouse reports: a mouse report is a
  click at a position, so the exemption would admit acting on a program rather than navigating
  it, and the bound would no longer be two keys.
