# ADR-973: Persisted commit classification markers

> Lifecycle: Active

## Context

History and the commit strip mark each commit from its diff and import edges (ADR-963), or
from the fleet's Architectural trailer when the fleet has classified it (ADR-965). The
diff-derived marker was cached only in the main process, bounded at a few thousand entries.
A repository with tens of thousands of commits, filtered to architecture changes, asks for
every loaded commit. Each restart, and every eviction past the bound, re-read modules and
re-ran pair scans for commits whose answer cannot have changed.

A diff-derived marker is a pure function of the commit, its first parent, the scanner
versions and the layout file at HEAD. Commits are immutable, so for a fixed key the answer
never goes stale.

## Decision

hvir keeps its diff-derived markers on disk as application state under Electron userData,
one file per host and repository, keyed by commit, first parent, and a digest of the scanner
versions and layout identity. Only `architecture`, `code` and `none` are stored; an
unclassified commit is still decided again on every request. The file holds digests and
markers only, is validated on read, and a corrupt or foreign file is discarded rather than
trusted. Each repository keeps a bounded number of entries, newest first, and the least
recently written repositories are evicted past a bounded count. Writes are coalesced and
written atomically through the local host, never on a project's host.

Fleet classifications are not stored. The notes ref and commit trailers remain their only
source, read on every request, and a fleet label still overrides the stored marker.

A classification request is sent only while some visible view still wants the commit. A
workspace that is hidden or left withdraws its queued commits instead of sending them to a
main process whose active workspace has moved on.

## Consequences

After a repository has been classified once, reopening History marks it from disk, and only
new commits are read and scanned. The git log read per batch and the fleet read still run.
A scanner or layout change misses every stored entry, and stale entries age out through the
per-repository bound. The store is a cache: deleting it costs one reclassification.

## Rejected alternatives

- Raising the in-memory bound only: memory grows with the largest repository viewed, and a
  restart still reclassifies everything.
- One file per commit, as the parse cache stores module facts: tens of thousands of tiny
  files per repository for a one-word answer.
- Storing fleet classifications beside the markers: ADR-965 rejects a second source of truth
  for fleet labels, and they can arrive after a commit is first marked.
