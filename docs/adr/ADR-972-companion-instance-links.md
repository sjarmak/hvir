# ADR-972: Explicit Companion instance links

> Lifecycle: Active

## Context

A phone may reach separate running hvir instances on different computers through
Tailscale. Each instance owns its listener, pairing, sessions, and permissions.
The phone needs an explicit destination without merging those authorities.

## Decision

The Companion displays its current endpoint and offers named saved links to other
Companion endpoints. Opening a link performs ordinary same-tab browser navigation.
The destination serves its own page and independently requires pairing. The
existing client continues making same-origin requests; no token, session handle,
return address, or settings travel in the link.

The bounded link catalog belongs to browser storage at the current origin. Links
are not synchronized between computers or browser origins. The UI explains this
boundary and browser Back provides a return path. Storage failures remain visible.
Endpoints must use HTTPS, except exact loopback HTTP for local use, and have the
root path with no user information, query, or fragment. Saved links are inert until
opened; hvir neither probes them nor claims their availability.

Leaving the page closes its event stream and mirror demand, invalidates pending
work, and disarms input. A page restored from browser history remains disconnected
until explicit reconnection. This extends the single-instance presentation of
ADR-949 without changing its listener, pairing, or permission boundaries.

## Consequences

People can name and switch between computers without exposing credentials to a
shared catalog or adding a network authority. Only one instance is active in the
page. Each origin has its own saved links and pairing; this modest duplication is
visible rather than hidden behind synchronization or cross-origin requests.

## Rejected alternatives

- A combined live view: requires cross-instance connection and identity ownership
  beyond an explicit destination switch.
- Shared credentials or a central instance registry: adds authority and lifecycle
  complexity to a browser navigation feature.
- Automatic discovery or health probes: introduces background reads and cannot
  reliably distinguish an unavailable computer from a missing network connection.
