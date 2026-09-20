# ADR-054: Sticky terminal modes precede the replayed tail

> Lifecycle: Partially superseded
> Supersedes: [ADR-050](ADR-050-companion-live-terminal-mirror.md) | partial | Main not interpreting the bytes it forwards, for a bounded scan of sticky DEC private modes emitted ahead of the replayed tail.
> Superseded by: [ADR-056](ADR-056-read-back-reaches-a-mouse-tracking-program.md) | partial | The mouse tracking family left to the window, for a mirror whose gesture the program's own wheel reports answer.

## Context

ADR-050 has the PTY stream attachment retain a bounded tail of raw output for every live PTY,
and it states the boundary in one sentence: bytes cross from main to the phone as they are, and
main does not interpret them. The retained tail is a window cut at whichever byte the budget
lands on. Everything the session said before that byte is gone, including the short sequences
whose whole purpose was to last.

The alternate screen is the one that matters. A program enters it once, at startup, with a
single sequence, and then writes for hours. By the time a phone opens a mirror the enter is far
outside the window, so the tail replays into an emulator sitting on the normal screen. The
program's redraws stack as scrollback instead of repainting one grid, the first frame is a pile
of overlapping screens, and the divergence lasts until the program happens to repaint
everything. ADR-052 made exactly that session the one the Companion exists to reach, and ADR-053
made the emulator's viewport the read-back, so a mirror wrongly on the normal screen now also
manufactures history the session never had.

No tail size fixes this. The distance from the enter to the present is unbounded, so a window
that always contains it does not exist. The information is not in the bytes that were kept, so
it has to be carried beside them.

## Decision

### Main holds the on and off state of a closed set of sticky modes and nothing else

The stream attachment scans passing output for the set and reset of a named, closed set of DEC
private modes and keeps, for each of them, the last state it observed and the position in the
stream where that transition sits. It builds no screen model, no cursor, and no cell grid; it
reads no content; and it retains no text of its own. A sequence split across two reads is
carried as the parse state of that sequence rather than as characters, so nothing of the stream
is held and where the read boundary falls changes no outcome. Everything outside the set is
data the scan passes over untouched. This is the one narrowing of ADR-050's rule that main does
not interpret the bytes it forwards.

That state replays as a preamble. When a reader attaches, a new mirror lease or a reattaching
renderer alike, main emits the carried modes as their own sequences ahead of the retained tail,
so the reader starts on the screen the session is actually on and the tail lands where it was
written.

### A preamble names only the modes the window it precedes cannot prove

Every reader starts from a window of retained output: the renderer from its replay, a mirror
from the tail, and the phone's own buffer from the tail it re-cuts on every remount. A mode
whose last transition still sits inside that window needs no preamble, and asserting it
anyway is worse than saying nothing. The emulator switches to the alternate screen before the
replayed characters that belong on the normal one are written, so they paint into a buffer the
session's own enter is about to clear, and the pane's scrollback for everything that ran before
the full-screen program is lost. So the preamble is computed against the exact window it
precedes and names only the transitions that fall before that window begins. A window that
carries its own transitions gets an empty preamble, which is what an ordinary shell gets.

The page runs the same scan over its own buffer rather than trusting the preamble it was sent.
Its window is cut independently of main's and keeps moving, so a transition main left to the
tail can roll out of the page's window later, and a preamble frozen at open time can outlive the
state it described.

### The carried set is the alternate screen, `?1049` and `?47`

Those two are carried and no others. Both are steady state: a session either is on the alternate
screen or is not, the last set or reset seen in the stream is the answer, and replaying that
answer into a fresh emulator reproduces it exactly. When the state is set the preamble emits it.
When it is reset the preamble is empty, because a fresh emulator already starts on the normal
screen. `?1047` names the same alternate buffer as `?47` under a different number and is
observed as `?47`: the two differ only in what their resets clear, and this scan emits no reset.
`?1049` is emitted before `?47` so its cursor save happens against the normal screen, the way
the program that wrote it ran it.

### Every other mode is left to the tail, for a stated reason

- `?2026`, synchronized output, is suppressed rather than replayed. A tail cut mid-frame leaves
  a set with no matching reset, and replaying that set freezes the phone's first frame until
  something else happens to end the frame.
- `?1048`, save and restore cursor, is an action with no steady state. Emitting the set saves
  the fresh emulator's home cursor, and a later `?1048l` or `?1049l` inside the tail restores it
  and jumps the cursor to home in the middle of the replay, corrupting the first frame this
  record exists to fix.
- The mouse tracking family, `?1000`, `?1002`, `?1003`, `?1006`, and `?1015`, is not carried.
  Carrying it makes the phone's emulator report that the program tracks the mouse, the one wheel
  policy of ADR-053 then routes every gesture to SGR mouse reports instead of the viewport, and
  a disarmed mirror drops those bytes while the policy still counts the gesture handled. The
  phone's read-back would stop working silently, with nothing on the screen to say why.
- `?25` cursor visibility, `?7` autowrap, `?1` application cursor keys, `?2004` bracketed paste,
  charset designation, keypad mode, DECSTBM, and SGR are not carried. Each is either restored by
  the program's own next write or costs a wrong cell, which is a smaller and self-correcting
  error than replaying onto the wrong screen.

### The preamble is a distinct wire field, not a prefix of the tail

The preamble travels beside the tail, as its own field on the mirror lease and on the page's
opened event. Prefixing it onto the tail is unshippable twice over. The page's event contract
rejects an opened event whose tail exceeds the tail bound, and the mirror's tail saturates at
exactly that bound in ordinary use, so a saturated tail plus any prefix is a protocol error that
ends the whole event stream and the mirror never opens at all. Even under the bound, the page
re-slices its retained text to the last tail-bound characters from the front on every remount
and every compaction, so a leading preamble survives the first paint and vanishes on the second.
A distinct field is not a convenience here; it is the only shape that holds.

## Consequences

A mirror and a reattaching renderer both start on the screen the session is on, so a full-screen
program's first frame is one grid instead of a stack of them. ADR-050's consequence that a raw
tail replays an imperfect first frame until the program redraws is narrowed to the modes this
record leaves out, and the alternate screen is no longer among them.

Two readers now hold the same scan, main's and the page's, and they can disagree about a window
neither one is wrong about. That is the price of letting each reader answer for the bytes it is
actually about to replay, and it means the scan is a shared contract rather than a main-side
detail: a change to the carried set has to move both.

Main now knows something about the bytes it forwards, and that is a boundary that only gets
harder to hold once it has been crossed. The line is drawn at a closed set of flags and the
positions they were seen at, with no screen behind them, so the next mode anyone wants carried
is a change to this record rather than an implementation detail of it. ADR-050's rejected
alternative of a headless emulator in main stays rejected, and nothing here moves main toward
one.

Every live PTY pays the scan whether or not a phone is watching, beside the tail it already
retains. The opened event gains an optional field, absent whenever the window carries its own
transitions, so an ordinary shell's opened is byte for byte what it was and a phone holding a
bundle built before this change keeps opening that mirror unchanged. The first opened that does
carry the field is refused by such a bundle, and the refusal is not confined to that frame: an
unrecognised shape is a protocol error that ends the whole event stream, so the page loses its
snapshots and its transcript with the mirror until it reloads.

Revisit this record if a mode outside the carried set is shown to break a real session's first
frame, if the scan would have to model a clearing or restoring action rather than a flag, or if
a reader other than a mirror and a reattaching renderer needs the preamble. Each is a different
decision, not an extension of this one.

## Rejected alternatives

- A headless emulator in main holding the screen and handing each reader its current state: this
  is ADR-050's rejected alternative and it stays rejected. It puts a copy of a renderer-owned
  surface in main, adds an emulator dependency to main, and interprets every byte rather than
  the handful this record names.
- Prefixing the preamble onto the retained tail: the page's contract rejects an opened event
  whose tail exceeds its bound, a saturated tail plus a prefix exceeds it, and the page
  re-slices the retained text from the front anyway, so the mirror would fail to open rather
  than open imperfectly.
- Retaining output from the last alternate-screen transition instead of a fixed window: the
  distance from that transition is unbounded, so the retention is unbounded, which is the
  property the tail budget exists to deny.
- Asking the desktop renderer's emulator for its mode state when a mirror attaches: a mirror is
  bound to a PTY instance and has to work while the renderer is hidden, throttled, or swapping
  documents, and ADR-050 keeps a mirror independent of a renderer document on purpose.
- Carrying every sticky mode the emulator understands: the mouse tracking family alone disables
  ADR-053's read-back on a disarmed mirror, and a set with no stated boundary is the headless
  emulator arriving one mode at a time.
