# Companion operator runbook

The Companion is a phone-sized page served by the running hvir app on a loopback port
([ADR-049](../adr/ADR-049-companion-observer-and-away-push.md)). It lists every session the
desktop lists, actionable ones first, and lets you answer a pending interaction or send a
message from the phone. While every hvir window is unfocused (Away), hvir also posts one Push
per session that enters the actionable set to a notification sink you declare. For a terminal
hvir launched itself, the page mirrors the desktop's screen and, once you allow it in Settings
and arm it on the page, carries your keystrokes back to that terminal
([ADR-050](../adr/ADR-050-companion-live-terminal-mirror.md)). While every hvir window is
unfocused, the mirror also sizes that terminal to the phone
([ADR-052](../adr/ADR-052-companion-mirror-holds-pty-size-while-away.md)).

hvir owns the listener, the pairing credential, and the outbound post. Everything that makes
the port reachable from a phone, and everything that turns a post into a notification on the
phone, is your infrastructure. This runbook shows one working shape of it: Tailscale to publish
the port inside your tailnet, and a self-hosted [ntfy](https://ntfy.sh) server to deliver Push
to iOS.

## What hvir never does

- Bind anything other than `127.0.0.1`. The listener dies with the app.
- Discover a tailnet or LAN address, or tell the phone where the desktop is.
- Manage TLS certificates or DNS names.
- Retry a failed Push. A failure shows in Settings status and nowhere else.
- Send Push while a desktop window is focused, or for a row whose attention is stale.
- Treat network reachability as authentication. A paired credential is required inside the
  tailnet too, because every local process can reach loopback.
- Resize a terminal from the phone while a desktop window is focused. The phone asks for its
  own grid only while every hvir window is unfocused (Away, the same signal that gates Push),
  and the desktop takes the size back the moment one of its windows gains focus (section 7).
- Clear Ready or Bell from a phone action. Viewing a mirror, typing into it, and answering an
  external session's pending interaction from the phone all leave those where they are;
  focusing the terminal on the desktop is still the rule that clears them. The one exception
  is a prompt entry, which a key typed into the mirror clears (section 9).
- Compose text into a terminal. A key sent from the phone is the exact bytes of that key,
  with nothing appended, and the free-text field sends what you typed, plus Enter only when
  you press the keyboard's return.
- Log, store, or push terminal bytes. Mirror output and phone keystrokes never reach the
  diagnostics, the settings file, or a Push body.

## Prerequisites

- The desktop that runs hvir and the phone are both nodes on one tailnet, with MagicDNS and
  HTTPS certificates enabled for the tailnet in the Tailscale admin console.
- Tailscale 1.50 or newer on the desktop, for the `tailscale serve --bg` syntax used below.
- Docker with the compose plugin on the desktop (or any machine on the tailnet) for ntfy.
- The ntfy app on the phone. Android delivers without any upstream; iOS needs the
  `NTFY_UPSTREAM_BASE_URL` setting described below.

## 1. Enable the Companion in hvir

Open Settings > Companion.

1. Turn **Serve the Companion on this machine** on.
2. Leave **Port** at its default, 47811, or choose any free port from 1024 to 65535. The
   listener binds `127.0.0.1:<port>` only.
3. Leave **Push sink** and **Push token** empty for now; section 4 fills them in.

The status line under the section reports whether the listener is up and on which port, or
the bind error if the port is taken.

## 2. Publish the port to the tailnet

On the desktop, publish the loopback port under the desktop's MagicDNS name:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:47811
tailscale serve status
```

Tailscale terminates TLS with a certificate it provisions for
`<desktop>.<tailnet>.ts.net` and forwards plain HTTP to hvir. The Companion page and its
event stream (server-sent events) pass through `tailscale serve` unchanged.

Never use `tailscale funnel` for this port. Funnel exposes the service to the public internet;
the Companion is designed for the tailnet only.

To stop publishing:

```sh
tailscale serve --https=443 off
```

## 3. Run ntfy for iOS

The ntfy iOS app cannot hold a connection open in the background. A self-hosted ntfy server
wakes it through Apple's push service by forwarding a poll request to the public ntfy.sh
instance. Only a hash of the topic and the message id travel upstream; the message text stays
on your server. This is what `NTFY_UPSTREAM_BASE_URL` configures.

`docker-compose.yml`:

```yaml
services:
  ntfy:
    image: binwiederhier/ntfy
    command: serve
    restart: unless-stopped
    ports:
      - '127.0.0.1:2586:80'
    volumes:
      - ./cache:/var/cache/ntfy
      - ./etc:/etc/ntfy
    environment:
      NTFY_BASE_URL: https://<desktop>.<tailnet>.ts.net:8443
      NTFY_UPSTREAM_BASE_URL: https://ntfy.sh
      NTFY_BEHIND_PROXY: 'true'
      NTFY_AUTH_FILE: /var/cache/ntfy/user.db
      NTFY_AUTH_DEFAULT_ACCESS: deny-all
      NTFY_CACHE_FILE: /var/cache/ntfy/cache.db
```

`NTFY_BASE_URL` must be the URL the phone will use, so publish port 2586 under a second
HTTPS port on the same MagicDNS name:

```sh
docker compose up -d
tailscale serve --bg --https=8443 http://127.0.0.1:2586
tailscale serve status
```

With `deny-all` in place, create one user for the phone, one publish-only user for hvir, and a
token hvir will present:

```sh
docker compose exec ntfy ntfy user add --role=admin phone
docker compose exec ntfy ntfy user add hvir
docker compose exec ntfy ntfy access hvir hvir-attention write-only
docker compose exec ntfy ntfy token add hvir
```

`hvir-attention` is the topic name; pick any name you like and keep it consistent below. The
last command prints the token once. Copy it.

On the phone, open the ntfy app, set Settings > Default server to
`https://<desktop>.<tailnet>.ts.net:8443`, sign in as `phone`, and subscribe to the topic.
Send a test message and confirm it arrives with the app closed:

```sh
curl -H "Authorization: Bearer <token>" -d "test" \
  https://<desktop>.<tailnet>.ts.net:8443/hvir-attention
```

## 4. Point hvir at the sink

Back in Settings > Companion:

- **Push sink**: `https://<desktop>.<tailnet>.ts.net:8443/hvir-attention`. hvir accepts
  `https://` URLs and `http://127.0.0.1` URLs, nothing else.
- **Push token**: the ntfy token from section 3.

hvir posts one plain-text body per Push, `<project> / <session title>`, with the kind of
signal (`ready`, `bell`, or `prompt`) as the notification title and one more line when there
is one: for an external session, the first line of its pending prompt; for a terminal prompt,
the message the terminal's notification carried (section 9). Either line is at most 120
characters. hvir presents the token as a bearer credential, makes one attempt with a 10 second
timeout, and never logs the token.

The token is stored encrypted through Electron's safeStorage, which uses the OS keychain. If
the keychain is unavailable, hvir refuses to store the token, keeps the URL, and says so in
the section. Settings shows only whether a token is set; the value never comes back out.

## 5. Pair the phone

1. In Settings > Companion choose **Issue pairing code**. The code is valid for 10 minutes;
   issuing again replaces it.
2. On the phone open `https://<desktop>.<tailnet>.ts.net/` and enter the code.

The phone exchanges the code once for a long-lived credential and keeps it in the browser's
local storage for that site. Five wrong codes within a minute lock pairing for a minute.

**Revoke pairing** in the same section invalidates the credential and closes every open Companion page
at once. Pair again by issuing a new code.

## 6. What to expect

- A page holds a Sessions projection lease only while it is open. Close the tab and hvir goes
  quiet again.
- Viewing a session on the phone never clears its attention. Answering a pending interaction
  resolves it, exactly as answering on the desktop does.
- Push fires once per session entering the actionable set while Away. A session leaving the
  set sends nothing, since a delivered notification cannot be retracted. A terminal that goes
  Ready again after a new submission produces a new Push. A terminal that is already in the
  set as Ready and then raises a prompt produces no second Push; its row and badge change to
  the prompt, but the set already held that session.
- A row whose fact went stale (for example, the observing stream to its supervisor was lost)
  is shown as unconfirmed with the reason and is never pushed
  ([ADR-048](../adr/ADR-048-exact-external-pending-interaction-attention.md)).
- The list is grouped by workspace: one heading per workspace, `project / workspace`, with
  `on <host>` for a workspace on an SSH host. Groups are in name order, so they hold still
  while attention moves; inside a group the rows keep the desktop's order, what is waiting
  on the person first.
- A row shows a `working` badge while the desktop sees its terminal working: output arriving
  on a terminal no window is focused on, after the person last pressed Enter in it. The badge
  is the desktop's own Working state and travels beside the actionable entries; it never
  pushes and never counts toward the OS badge. An external agent whose source reports its
  turn as working shows the same badge.
- Each running hvir serves its own Companion and pairs on its own. Two desktops mean two
  pairings and two Push URLs, or one shared topic.
- Selecting a row without a live hvir terminal keeps the path ADR-049 gave it. An external
  session shows its transcript with the answer and message controls; a row hvir launched whose
  terminal has since exited, or whose host is disconnected, shows one plain sentence in place
  of the transcript, for example `This session is no longer in the current Sessions view.`,
  and no terminal. The sentences are the ones the desktop's Sessions detail shows for the same
  row; the phone never prints a reason code.

## 7. Mirror a live terminal

A row mirrors when the desktop would offer Interact for it: the session is live, its host is
connected, and hvir owns the PTY behind it. That covers a shell running Claude Code or Codex,
a `gc session attach` terminal, and a terminal on an SSH host alike. Select such a row and the
page becomes a fixed column, rendered on the phone by the same ghostty-web emulator the
desktop uses: one header line with **Sessions** and the row's title (and **Transcript** on a
row that takes answers); the terminal taking every pixel that remains; and one control bar at
the bottom (section 8).
While the row carries a prompt, the header shows its message under the title (section 9).

What the phone shows:

- The desktop's screen from a retained tail of output onward. hvir keeps the newest 256K
  characters of every live PTY's output in main, so the first frame replays that raw tail
  rather than a snapshot of the screen. Until the program redraws, cursor position and any
  partially overwritten line can look wrong; a full-screen program such as Claude Code
  redraws on its next output, and a shell prompt is right after its next Enter. The Claude
  Code permission prompt that is on the desktop's screen is on the phone's.
- The grid hvir publishes, in a fixed 15 px font. While a desktop window is focused that is
  the desktop terminal's columns and rows, and a CSS transform scales it into the phone's
  width, so a 200-column desktop terminal reads small and the remedy at the desk is a narrower
  desktop pane. Every resize on the desktop reaches the phone as a geometry frame and the
  emulator there follows it.
- The phone's own grid while the desktop is Away. With every hvir window unfocused, the phone
  measures its terminal area, asks hvir to size the terminal to the columns and rows that area
  holds, and draws that grid unscaled, edge to edge. It asks once when the mirror is live and
  the desktop is Away, and once more after the area settles following a rotation or the soft
  keyboard appearing or leaving; one request is in flight at a time and a later grid waits
  behind it, so the terminal ends at the latest one. Typing permission does not gate this: a
  mirror that cannot type still sizes the terminal while Away. When a desktop window gains
  focus the desktop reclaims, its geometry frame arrives like any other, and the phone returns
  to the scaled grid.
- Why the rule exists. A full-screen program (Claude Code started with `"tui": "fullscreen"`,
  vim, less) draws on the alternate screen, where the emulator keeps no scrollback, so its
  mirror reads it back by paging the program rather than by moving the view, and a scaled
  desktop grid is a short strip at the bottom
  with black above it. Sized to the phone, the program lays out for the phone and fills it. A
  shell's mirror reads back through its own scrollback at either size.
- The status line `The desktop is focused, so it keeps the terminal size.` under the header
  when the phone asked and a focused desktop refused. The phone asks only while its snapshot
  says Away, so the line appears when a desktop window regained focus before the request
  landed. The mirror stays live at the desktop's grid, and the line goes away when a later
  request is accepted.
- The session's earlier output in the terminal itself, in full colour. The phone reads back by
  moving the emulator's own view over the scrollback the session already holds, so what you
  read is drawn by the same renderer that draws the live screen: colours, bold, box drawing,
  and wide characters are exactly what the desktop pane shows. The grid sits at the bottom of
  the area just above the controls, with any spare room above it as in a terminal, and it
  stays there as output arrives unless you have read back.
- Reading back under your finger or a wheel. A drag over the grid moves that view: toward the
  bottom of the screen for earlier output, toward the top to return to the live screen, or one
  tap on the way-back button described below for the whole distance at once. A
  wheel notch does the same thing, and both are decided by the one policy, so they never
  disagree. How far one step travels does differ, because a notch is a discrete step of intent
  and a finger is distance: a page key costs a drag half the rows on screen, so dragging half
  the terminal moves it by a screen.

  Which of those you get depends on the session, and the phone decides it the same way the
  desktop does. A program that asked for mouse reports, which is every tmux session with
  `mouse on`, receives the wheel reports its own desktop sends, so read-back on the phone is
  whatever that program does for a wheel. A full-screen program that did not ask for them
  receives Page Up and Page Down. Everything else moves the phone's own view. Before ADR-056
  the phone did not know about mouse tracking and sent page keys to sessions whose desktop was
  sending reports, which is why a tmux mirror used to scroll a few lines and stop while the
  desktop moved freely. In a full-screen program (Claude Code, vim, less) the emulator keeps no scrollback
  to move, so the gesture sends Page Up and Page Down to the program instead, which is how the
  desktop pane scrolls the same session. Those two keys are not typing: they need the Settings
  permission (section 8) but not the per-mirror arm, and neither do the wheel reports a
  mouse-tracking program gets instead, so reading back works on a mirror you never armed,
  extends no arming, and raises no attention on the desktop. With the permission
  off, the page says `Input from the Companion is off in Settings, so this program cannot be
  paged`. A program that asked for mouse reports receives them the same way, and those are
  typing: a mouse report that is a press, a release, or a drag rather than one of the two wheel
  buttons is typing, so a disarmed mirror sends none of those.
  Paging a program's own history is not private to the phone. It is the same program with one
  screen, so a desktop watching that terminal moves with you; reading back through the
  emulator's own view does not do that. A grid taller than the area keeps scrolling under the
  same drag once the view reaches its own end, so rows below the fold are a continuation of
  the gesture rather than a separate one.
- The button `The session has moved on. Back to live.` in the bottom corner of the terminal,
  only while you have read back. The terminal keeps your place as output arrives, which is why
  the screen does not jump under you mid-read, so this is what tells you the session has moved
  on and puts you back on its newest output in one tap. Over a grid taller than the phone the
  tap travels the whole way: the view returns to the live edge and the terminal scrolls to the
  bottom of the grid, so you land on the newest rows rather than on the first ones. It stays
  put while you drag, and it goes away by itself when the view reaches the newest output again,
  whether you tapped it or dragged there. A full-screen program never shows it: there is no
  scrollback to be behind. A session that ended keeps it until you return, since its last
  output is still there to read.
- The line `This program keeps its own history. Drag to page back through it.` under the
  header while the session is in a full-screen program. Its earlier turns live inside the
  program rather than in the terminal's scrollback, which is why the drag pages the program
  instead of moving the view. A program that binds Page Up and Page Down to something other
  than scrolling does that instead, on the phone and on the desktop alike.
- A **Transcript** button in the header on rows that also take answers (an external session
  attached inside an hvir terminal), switching between the mirror and the ADR-049 transcript
  view.

What the desktop shows while a phone holds the size: the pane draws the grid at the phone's
columns and rows in its top-left corner, leaves the rest of the pane blank, and shows one line
in its bottom-right corner, `Companion holds the size · C×R`. The pane does not fit, scale, or
crop that grid. Focus any hvir window and the desktop reclaims: the visible pane refits to its
own size within one fit cycle and the phone returns to the scaled view as that geometry reaches
it. A pane on a hidden tab refits when the tab is shown. Two phones mirroring one terminal both hold
it, and the most recent resize wins.

The mirror survives a reload of the desktop window, because it is bound to the PTY instance
and not to the renderer document. It ends, with one sentence on the page, when the terminal
exits or hvir releases it (`The terminal ended.`), when the page selects another row
(`Another row was selected.`), when the phone stops draining the event stream fast enough
and 4 MiB of output backs up (`The phone fell behind; select the row again.`), or when the
page closes, pairing is revoked, or hvir shuts down (`The desktop closed this mirror.`). A
mirror that fell behind is not resumed on its own; select the row again and the page starts
from the current tail.

**Sessions** on the phone returns to the list and disarms typing, but the mirror stays open
on the desktop side until you select another row or close the tab, and the page keeps its own
bounded copy of the stream meanwhile. Selecting the row again opens a fresh mirror and starts
from the retained tail.

## 8. Allow typing from the phone

Typing is off until you turn it on in three places, and each is independent of the others.

1. In Settings > Companion, turn **Allow typing from the Companion** on and choose **Apply**.
   The status line under the section says `typing allowed` or `typing off`. The setting is
   stored beside the port and the Push sink, and it defaults to off on every install.
2. On the phone, with a mirror open, choose **Arm typing** in the control bar under the
   terminal. While disarmed the bar holds that one button. While armed the button reads
   **Disarm**, a strip of on-screen keys appears beside it, a text field with **Send**
   appears under it, and keys typed on the emulator itself are accepted. Arming is per
   mirror: selecting another row, a mirror ending, hiding the page (switching apps, locking
   the phone, backgrounding the tab), and two minutes with no key sent all disarm it, and the
   keys and the text field go away with it. Every key you send restarts the two minutes.
3. Send a key. The strip carries Esc, Tab, Ctrl-C, the four arrows, and Enter, and scrolls
   sideways when the phone is too narrow for all of them. Each sends the bytes of that key
   and nothing else; the arrows send the CSI form (`ESC [ A` and so on), which is what a
   program reads in the terminal's default cursor mode; a program that switched the terminal
   to application cursor mode reads the same bytes differently, and the page does not track
   that mode. The text field's **Send** posts the text exactly as typed, and the phone
   keyboard's return posts it followed by Enter. One request carries at most 4096 characters.

A keystroke reaches the exact PTY instance the mirror was opened on. When the terminal has
exited or been replaced since, the listener answers `409` and the page says
`The mirrored terminal ended or changed`; when Settings has typing off, it answers `403`, the
page says `Typing from the Companion is off in Settings` and disarms itself. Neither case
writes anything.

An Enter sent from the phone arms the same Ready detection a desktop Enter does: main tells
the desktop window that owns the terminal what was typed, the renderer records it as input,
and the next quiet period after output produces Ready and, while Away, one Push. The row
leaves the actionable set when output resumes, exactly as on the desktop. One case does not
arm: an Enter sent while the desktop window is reloading its document. The keystroke still
reaches the terminal, but the notice goes to the window generation that owned the PTY at that
instant and a swapping renderer drops it, so that one submission produces no Ready and no
Push. The next submission, from either end, arms detection again.

Any key that reaches the terminal from the phone, Enter or not, also clears a prompt entry on
that terminal (section 9). Ready and Bell are not touched by phone input.

## 9. Prompt attention from the harness

A harness that is blocked on a permission prompt and one that has finished its turn both go
quiet, so both show as Ready. A harness can say which it is by writing a terminal notification
(OSC 9 or OSC 777) into the PTY, and hvir shows that as a **prompt** with the message the
notification carried ([ADR-051](../adr/ADR-051-terminal-notification-prompt-attention.md)).
The message is the harness's own words, cut to its first line and at most 120 characters. hvir
never reads the screen for this; the notification sequence is the only source of a prompt.

### Make Claude Code emit it

hvir does not configure the harness. Set Claude Code's notification channel to the iTerm2
style, which is the OSC 9 form, in `~/.claude/settings.json`:

```json
{ "preferredNotifChannel": "iterm2" }
```

or on one command line:

```sh
claude --settings '{"preferredNotifChannel":"iterm2"}'
```

Two things to know about when the sequence arrives:

- Claude Code waits a few seconds after a permission prompt appears before it notifies, about
  six seconds in our probe of Claude Code 2.1.277 under `TERM_PROGRAM=hvir`. The terminal is
  silent meanwhile, so the prompt shows on the phone a few seconds after it shows on the
  desktop's screen.
- Claude Code 2.1.27x defaults to its auto permission mode, in which many commands never
  prompt at all, so a session in that mode emits no permission notification for them. Start it
  with `--permission-mode default` to see permission prompts.

Claude Code also notifies when it finishes a turn (`Claude is waiting for your input`). That
arrives as a prompt too, so a finished turn can show first as Ready and then, when the
notification lands, as a prompt with that message. A harness that emits no notification keeps
the Ready behavior exactly as before.

### What each surface shows

A prompt outranks Ready and Bell on the same terminal, and a later notification replaces the
message. The entry reaches every surface the terminal's attention already reaches:

- The desktop terminal rail shows a `prompt` badge on the row; hovering it, or a screen
  reader, gives `Prompt: <message>`. The collapsed rail shows a `P` marker on the row and a
  `P <count>` rollup ahead of the Ready and Bell counts.
- The desktop Sessions view shows `Prompt: <message>` as the row's Attention fact.
- The Companion list shows a `prompt` badge on the row and the message on its own line under
  the row's title.
- The Companion mirror shows the message in the header, under the row's title, for as long as
  the row carries it.
- Push, while Away, sends the usual `<project> / <session title>` body with `prompt` as the
  notification title and the message as the second line (section 4).

### What clears it

- Focusing the terminal on the desktop, as for Ready and Bell.
- A key that reaches the terminal from the Companion mirror. Typing into a mirrored terminal
  is the person answering what the notification asked, so any key sent from the phone clears
  the prompt entry on that terminal and nothing else: Ready and Bell on that terminal, and
  attention on every other terminal, are unchanged by phone input. A stray key clears the
  entry too; the prompt is still on the mirrored screen, and the harness does not notify
  again for it.
- Nothing else. Output resuming does not clear a prompt, because a repaint and an answer
  produce the same bytes. A second prompt in the same session shows again without a desktop
  focus in between.

The message is not persisted. A prompt that is restored with a session after an hvir restart
shows as a prompt without its message until the harness notifies again.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Phone gets `401` on every request | Not paired, or revoked. Issue a new pairing code. |
| Pairing answers `429` | Five failed codes within a minute. Wait a minute and retry with the current code. |
| Page loads but shows no rows | The event stream is buffered or blocked by a proxy. `tailscale serve` passes it; a custom reverse proxy must disable response buffering for `/api/events`. |
| `tailscale serve` fails to provision a certificate | Enable HTTPS certificates and MagicDNS for the tailnet in the admin console, then rerun the command. |
| No Push arrives | Check that a desktop window is not focused (Push is Away-only), that the row is not stale, and read the sink status under Settings > Companion. Then repeat the `curl` test from section 3. |
| Push arrives on Android only | `NTFY_UPSTREAM_BASE_URL` is missing or `NTFY_BASE_URL` differs from the server URL configured in the iOS app. |
| Settings refuses the token | The OS keychain is unavailable to Electron's safeStorage. On Linux, install and unlock a Secret Service provider such as GNOME Keyring or KWallet. |
| Port already in use at startup | Another process holds the port. Change **Port** in Settings and update the `tailscale serve` target. |
| Selecting a live terminal row shows `The terminal could not be shown` | The emulator's WebAssembly module did not load. A custom reverse proxy must pass `application/wasm` unchanged and must not rewrite the page's Content-Security-Policy header; `tailscale serve` does neither. Under `npm run dev`, rebuild so the module exists in `out/renderer/assets`. |
| On-screen keys and the text field stay disabled | Typing is not armed, or the mirror ended. Choose **Arm typing**; if the button is disabled, the row has no live mirror, so select it again. |
| Every key answers `Typing from the Companion is off in Settings` | **Allow typing from the Companion** is off, or was turned off after pairing. Turn it on and choose **Apply**, then arm again. |
| The page says `The phone fell behind; select the row again.` | Output outran the phone's connection by more than 4 MiB. Select the row again; the mirror restarts from the current tail. |
| An Enter from the phone produced no Ready and no Push | The desktop window was reloading when the key landed, so the renderer never recorded the input, or a desktop window was focused. The next submission arms Ready detection again. |
| A Claude Code permission prompt shows as Ready, or not at all, never as a prompt | The notification channel is not set: put `"preferredNotifChannel": "iterm2"` in `~/.claude/settings.json` or pass `--settings '{"preferredNotifChannel":"iterm2"}'`. If it is set and still nothing arrives, the session is in auto permission mode and the command never prompted; start Claude Code with `--permission-mode default`. Wait the few seconds Claude Code holds before notifying. |
| A prompt badge shows but no Push arrived for it | The terminal was already in the actionable set as Ready when the prompt arrived; Push fires only when a session enters the set. Or a desktop window was focused. |
| The mirror shows old output and never catches up | The view is read back, which the terminal holds on purpose so output does not move the rows you are reading. Tap `The session has moved on. Back to live.` in the bottom corner, or drag toward the top of the screen. |
| A drag or wheel over a full-screen program (vim, less, Claude Code) moves nothing | Both gestures reach the same policy, which sends the program either wheel reports (if it asked for mouse tracking, as a tmux session with `mouse on` does) or Page Up and Page Down, so what happens next is the program's answer to those. They need the Settings permission (**Allow typing from the Companion**) but not **Arm typing**; if the page says `Input from the Companion is off in Settings, so this program cannot be paged`, turn the setting on at the desktop. A program that binds those keys elsewhere, or a shell with no pager running, moves nothing by design. A program that asked for mouse reports receives reports instead, and those do need the arm. If the grid is taller than the area, the drag still scrolls it either way. |
| The mirror is a thin strip at the bottom with black above it | The phone is showing the desktop's grid scaled to its width, and the program draws on the alternate screen, so the terminal keeps no scrollback to fill the space, which the mirror says in a line of its own. A desktop window is focused, or the mirror is not live. With a focused desktop the phone does not ask and shows no line; if it asked just as a desktop window regained focus, the line under the header reads `The desktop is focused, so it keeps the terminal size.` A mirror that ended shows its one sentence instead, so select the row again. Leave the desk, or unfocus every hvir window (switch the desktop to another app), and the phone asks for its own grid. At the desk the remedy is still a narrower desktop pane. |
| The desktop pane shows a small grid in its top-left corner and `Companion holds the size · C×R` | A phone holds the terminal's size because every hvir window was unfocused when its mirror asked. Focus any hvir window and the pane refits to its own size; the phone returns to the scaled view as that geometry reaches it. A pane on a hidden tab refits when the tab is shown. |
| Reading back shows a frame of a full-screen program twice, or a stale line | What you read is the terminal's scrollback as it stands; a program that redraws by moving the cursor leaves its earlier frames there, as on the desktop. The live screen is the screen as drawn. |
| Reading back jumps further back, to the oldest line, after the terminal resizes | A resize reflows the scrollback, and a position further back than the reflowed scrollback reaches is moved to its oldest row. While the desktop is Away the phone asks for its own grid whenever the area changes, so rotating the phone or raising the keyboard can do this. Drag toward the top of the screen to return to the live screen. |

## Developer note

The page is built as a second Vite entry and served from `out/renderer/companion`, with its
scripts, styles, and the ghostty-web WebAssembly module as flat files under
`out/renderer/assets`. Run the build before using the Companion under `npm run dev`, or the
listener answers `GET /` with a 404 until the page exists. The listener serves only the
extensions its allowlist names (`src/main/companion/companion-assets.ts`); a new asset type in
the page bundle needs an entry there, and `npm run smoke:scenario -- companion` proves the
module is served as `application/wasm`.
