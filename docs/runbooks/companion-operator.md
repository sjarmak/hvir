# Companion operator runbook

The Companion is a phone-sized page served by the running hvir app on a loopback port
([ADR-049](../adr/ADR-049-companion-observer-and-away-push.md)). It lists every session the
desktop lists, actionable ones first, and lets you answer a pending interaction or send a
message from the phone. While every hvir window is unfocused (Away), hvir also posts one Push
per session that enters the actionable set to a notification sink you declare.

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

## Prerequisites

- The desktop that runs hvir and the phone are both nodes on one tailnet, with MagicDNS and
  HTTPS certificates enabled for the tailnet in the Tailscale admin console.
- Tailscale 1.50 or newer on the desktop, for the `tailscale serve --bg` syntax used below.
- Docker with the compose plugin on the desktop (or any machine on the tailnet) for ntfy.
- The ntfy app on the phone. Android delivers without any upstream; iOS needs the
  `NTFY_UPSTREAM_BASE_URL` setting described below.

## 1. Enable the Companion in hvir

Open Settings > Companion.

1. Turn **enable** on.
2. Leave **port** at its default, 47811, or choose any free port from 1024 to 65535. The
   listener binds `127.0.0.1:<port>` only.
3. Leave **Push URL** and **token** empty for now; section 4 fills them in.

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

- **Push URL**: `https://<desktop>.<tailnet>.ts.net:8443/hvir-attention`. hvir accepts
  `https://` URLs and `http://127.0.0.1` URLs, nothing else.
- **token**: the ntfy token from section 3.

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

**Revoke** in the same section invalidates the credential and closes every open Companion page
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
| Port already in use at startup | Another process holds the port. Change **port** in Settings and update the `tailscale serve` target. |

## Developer note

The page is built as a second Vite entry and served from `out/renderer/companion`. Run the
build before using the Companion under `npm run dev`, or the listener answers `GET /` with a
404 until the page exists.
