# Companion operator runbook

The Companion is a phone-sized page served by the running hvir app on a loopback port
([ADR-049](../adr/ADR-049-companion-observer-and-away-push.md)). It lists every session the
desktop lists, actionable ones first, and lets you answer a pending interaction or send a
message from the phone. While every hvir window is unfocused (Away), hvir also posts one Push
per session that enters the actionable set to a notification sink you declare. For a terminal
hvir launched itself, the page mirrors the desktop's screen and, once you allow it in Settings
and arm it on the page, carries your keystrokes back to that terminal
([ADR-050](../adr/ADR-050-companion-live-terminal-mirror.md)).

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
- Resize a terminal from the phone. The phone renders the desktop's columns and rows and
  scales them to fit; only the desktop pane changes the grid.
- Clear attention from a phone action. Viewing a mirror, typing into it, and answering a
  prompt from the phone all leave attention where it is; focusing the terminal on the desktop
  is still the only clearing rule.
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
signal as the notification title and the first line of the pending prompt (at most 120
characters) when there is one. It presents the token as a bearer credential, makes one attempt
with a 10 second timeout, and never logs the token.

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
  Ready again after a new submission produces a new Push.
- A row whose fact went stale (for example, the observing stream to its supervisor was lost)
  is shown as unconfirmed with the reason and is never pushed
  ([ADR-048](../adr/ADR-048-exact-external-pending-interaction-attention.md)).
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
page opens a terminal view in place of the transcript, rendered on the phone by the same
ghostty-web emulator the desktop uses.

What the phone shows:

- The desktop's screen from a retained tail of output onward. hvir keeps the newest 256K
  characters of every live PTY's output in main, so the first frame replays that raw tail
  rather than a snapshot of the screen. Until the program redraws, cursor position and any
  partially overwritten line can look wrong; a full-screen program such as Claude Code
  redraws on its next output, and a shell prompt is right after its next Enter. The Claude
  Code permission prompt that is on the desktop's screen is on the phone's.
- The desktop's geometry. The grid is exactly the desktop terminal's columns and rows, scaled
  by a CSS transform to fit the phone's width, so a 200-column desktop terminal reads small on
  a phone. Narrow the desktop pane to make the phone readable; every resize on the desktop
  reaches the phone as a geometry frame and the emulator there follows it.
- A **Transcript** button on rows that also take answers (an external session attached inside
  an hvir terminal), switching between the mirror and the ADR-049 transcript view.

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
2. On the phone, with a mirror open, choose **Arm typing**. The button reads **Disarm** while
   armed, the on-screen keys and the text field come alive, and keys typed on the emulator
   itself are accepted. Arming is per mirror: selecting another row, a mirror ending, hiding
   the page (switching apps, locking the phone, backgrounding the tab), and two minutes with
   no key sent all disarm it. Every key you send restarts the two minutes.
3. Send a key. The row of on-screen keys carries Esc, Tab, Ctrl-C, the four arrows, and
   Enter. Each sends the bytes of that key and nothing else; the arrows send the CSI form
   (`ESC [ A` and so on), which is what a program reads in the terminal's default cursor
   mode; a program that switched the terminal to application cursor mode reads the same
   bytes differently, and the page does not track that mode. The text field's **Send** posts
   the text exactly as typed, and the phone
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

## Developer note

The page is built as a second Vite entry and served from `out/renderer/companion`, with its
scripts, styles, and the ghostty-web WebAssembly module as flat files under
`out/renderer/assets`. Run the build before using the Companion under `npm run dev`, or the
listener answers `GET /` with a 404 until the page exists. The listener serves only the
extensions its allowlist names (`src/main/companion/companion-assets.ts`); a new asset type in
the page bundle needs an entry there, and `npm run smoke:scenario -- companion` proves the
module is served as `application/wasm`.
