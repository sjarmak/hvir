# ADR-051: A terminal's in-band notification is actionable attention that carries its message

> Lifecycle: Active
> Supersedes: [ADR-009](ADR-009-hierarchical-attention.md) | partial | Terminal focus as the only rule that clears a terminal's own attention, for a prompt entry answered through the Companion mirror.
> Supersedes: [ADR-050](ADR-050-companion-live-terminal-mirror.md) | partial | No phone action clearing attention, for a prompt entry on the mirrored terminal.

## Context

ADR-019 classifies a terminal as Ready when its output goes quiet after an Enter, and ADR-009
makes focusing that terminal the only thing that clears it. Neither says why the terminal is
waiting. A harness that has finished its turn and a harness that is blocked on a permission
prompt or an option picker both look like quiet output, so the terminal row, the Sessions view,
and the Companion page all show the same Ready badge for both, and the person cannot tell
which sessions need a decision from them.

The harness can say why. Claude Code, with its notification channel set to the iTerm2 style,
writes an OSC 9 notification into the PTY when a permission prompt has waited a few seconds
(`Claude needs your permission`) and when it finishes a turn (`Claude is waiting for your
input`). The sequence is terminal protocol, like a title change or a bell, and it crosses the
PTY the same way on a local and an SSH host. hvir's terminal pane already translates OSC 9 and
OSC 777 into a notification event with a title and a body (ADR-003 keeps that translation
behind the pane seam), and then collapses it into a bell, dropping the message.

Two things make the current rules insufficient once a mirror exists (ADR-050). A row that went
Ready stays Ready until its terminal is focused on the desktop, so a second prompt in the same
session is invisible in the actionable set. And a prompt answered from the phone leaves the row
flagged as waiting, because ADR-050 forbids any phone action from clearing attention.

## Decision

### The notification becomes an attention kind with its message

A terminal notification event raises a `prompt` attention on that terminal immediately. It
needs no Enter to arm it and no quiet period, because the harness asserted the state itself. The
attention carries the notification's body, bounded to one short line, and that body crosses every
projection the terminal's attention already crosses: the renderer's actionable entries, main's
actionable set, the Sessions projection row, the Companion row, and the Push line. A `prompt`
entry outranks Ready and Bell on the same terminal, and a later notification replaces the body.

The notification is not screen inspection. ADR-019's rule that attention never reads screen
contents or provider telemetry holds: the sequence is an explicit statement by the program in the
terminal's own protocol, exactly as a bell is. OSC 9 no longer maps to a bell; the BEL byte
remains the bell.

### A prompt entry clears on focus or on an answer from either keyboard

ADR-009's focus rule still clears a prompt entry. In addition, input to that terminal from the
Companion mirror clears the prompt entry, and only the prompt entry: a keystroke into a
mirrored terminal is the person answering what the notification asked. Desktop input already
implies focus. Ready and Bell keep ADR-050's rule that no phone action clears them. Output
resuming does not clear a prompt entry, because a repaint and an answer produce the same bytes.

### Every surface shows the message

The terminal row's badge names the kind and offers the message; the desktop Sessions view shows
the message beside the attention value; the Companion list shows it on the row, and the mirror
view shows it above the terminal so the phone says why it is showing that screen. Away-time Push
for a prompt entry carries the message as its line.

### hvir does not configure the harness

The harness must emit the sequence. hvir documents the setting for Claude Code and does not write
it into the user's configuration, because most sessions are started from a shell inside an hvir
terminal where hvir passes no flags, and because the setting belongs to the user's harness
installation. A harness that emits nothing keeps the ADR-019 Ready behavior unchanged.

## Consequences

The Sessions view and the phone distinguish a session that needs a decision from one that
finished, with the harness's own words. A permission prompt shows on both within the delay the
harness applies before notifying, a few seconds for Claude Code, and a second prompt in the same
session shows again without a desktop focus in between.

The attention model gains a payload. The actionable entry, the Sessions row, and the Companion
row each carry an optional bounded string, validated at every boundary. A stray key from the
phone clears a prompt entry the person did not answer; the prompt remains on the mirrored screen
they are looking at, and the harness does not notify again for it.

A harness's idle notification also arrives as a prompt entry, so a finished turn can show first
as Ready and then, when the notification lands, as a prompt with the harness's waiting message.
That is the harness's statement and hvir shows it as given.

Revisit this record if a harness offers a structured channel for the pending question and its
options, if hvir launches every session itself and can set the notification channel on the
harness's command line, or if the phone should answer a prompt by choice rather than by key.

## Rejected alternatives

- Recognizing the prompt on screen (matching `Do you want to proceed?` or an option list in the
  emulator's rows): provider-specific text, fragile under redraw and resize, and exactly the
  content inspection ADR-019 forbids.
- Claude Code's Notification hook calling back into hvir: a process on the harness's host would
  need a route into the running app, which on an SSH host is not reachable, and every harness
  would need its own hook shape. The in-band sequence needs nothing outside the PTY.
- Reading the harness's transcript files: a permission prompt never appears in them (ADR-050).
- Clearing a prompt entry when output resumes: an answered prompt and a repainted one produce
  the same bytes, so the entry would clear on a resize or a spinner.
- hvir setting the harness's notification channel at launch or in its configuration: hvir does
  not own the harness's settings, and a session started from a shell inside an hvir terminal
  receives no flags from hvir.
- Keeping the notification as a bell and showing the bell body: the bell has no body, and a bell
  cannot be told from a prompt on any surface that counts them.
