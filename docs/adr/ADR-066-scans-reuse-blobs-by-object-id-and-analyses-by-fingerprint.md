# ADR-066: Scans reuse blobs by object id and analyses by fingerprint

> Lifecycle: Active

## Context

ADR-063 made an architecture scan record its cost per stage and cached parsed module facts
on disk, so a repeat scan of the same files parses nothing. Measured on hvir's own history
before this decision (baseline HEAD~40, current HEAD, 1574 and 1625 files, warm parse
cache), the remaining cost of a repeat scan was dominated by reading the same bytes from Git
again: of 360 ms, blob reads took 148 ms for 20.7 MiB across the two sides, parsing 125 ms,
listing 54 ms, comparison 17 ms and serialising the 7.2 MiB renderer payload 10 ms. Just
under half of all file reads in one scan were of a blob already read for the other side.
Over an SSH host the transfer, not the parse, sets the pace. A reviewer refreshes the same
pair repeatedly: after an edit, after a commit, after returning to a tab, and the History
strip's classifier scans neighbouring commit pairs that share nearly every blob.

Git blob ids are content addressed: two files with one id hold the same bytes, and every id
the capture handles is verified by rehashing the bytes it received (ADR-063), for live files
as much as for objects read from Git. An id-keyed cache therefore needs no invalidation, only
a bound. A capture's fingerprint likewise names the analysis it produces: it is the digest of
the root, the two resolved revisions, the scope constants, the layout identity and every path
and object pair on both sides, and the analysis worker reads nothing else from the capture.
Within one process, where the scanner versions cannot change, two captures with one
fingerprint have one analysis.

## Decision

The coordinator owns two in-memory, byte-bounded, least-recently-used caches for the life of
the process. Nothing is written to disk; the parse cache of ADR-063 remains the only
persistent one.

The blob cache maps an object id to the decoded text of that object. Every Git blob read
consults it first and asks Git only for the ids it lacks, in one batch as before; what Git
returns is verified and then stored. Live files, once their bytes have been verified against
their ids, are stored too, so the baseline read that follows a live read in the same scan, and
any later scan of a commit holding the same bytes, costs nothing. The cache is shared by
review scans and by the History classifier's reads. Capture without a caller-supplied cache
creates one for the call, so the two sides of a single scan share blobs whoever runs it. Its
bound is twice the scope's total byte cap, 32 MiB: one scan may hold a full cap of bytes on
each side, and a smaller bound could evict the current side while the baseline is still being
read. One hvir pair occupies 11.3 MiB, so the bound holds about three such pairs.

The analysis cache maps a capture fingerprint to the analysis produced for it. A review scan
looks its fingerprint up before asking the worker and stores the result after, weighted by
the serialised size of the renderer payload the same scan already measures. Its bound is
32 MiB, which holds one analysis for each of the four reviews the coordinator allows open at
once at hvir's measured payload size. The classifier does not use it: its own result cache
already keys the answer it needs, and its bulk scans would churn the reviews' entries.

The blob-read span reports what the scan cost, not what it delivered: bytes and host calls
count only what Git transferred, and items count the files the side holds. A fully cached
read shows its items with zero bytes and zero host calls. A scan whose analysis was cached
shows no worker, parse or compare spans, because none ran. No stage was added and no renderer
contract changed.

## Consequences

Measured after the change on the same pair: the first scan fetches 11.3 MiB in 2 host calls
because the sides share blobs within the scan; the second scan's blob reads take 1 ms with
0 bytes and 0 host calls, and the whole capture falls from 135 ms to 50 ms, of which listing
is 43 ms. Scanning the neighbouring pair, HEAD~41 to HEAD~1, afterwards fetches 0.04 MiB in
1 host call. A live scan after either still reads its live side in full, 10.6 MiB in 103 ms,
but reads no baseline blobs. With the analysis cache, a repeat review scan also skips the
worker transfer of the whole capture, parsing and comparison.

A cached analysis replays the diagnostics its original run produced; a note about the parse
cache being unavailable at the time stays on the snapshot until the fingerprint changes.
Cache entries hold decoded text and analysis objects whose in-memory size exceeds the bytes
they are charged, so the two bounds are floors on memory, not ceilings; both are small next
to the parse cache's 256 MiB. Cache state lives and dies with the main process; a scanner
upgrade restarts the app and empties both caches with it.

Tests assert on host call counts and transferred bytes recorded by the scan recorder, not on
time: a repeat scan of one pair makes no blob read host calls; committing a change to one file
makes the current side re-read exactly that blob, with the new content and object id, while
the baseline side reads nothing; live files stored by one scan serve a later commit of the
same bytes. A seeded model test checks the cache against a recency-ordered list over random
stores and lookups.

Revisit if scans regularly exceed a single pair per bound, if listing becomes the dominant
stage worth caching by tree id, or if the classifier's scans would benefit from analyses the
reviews already hold.

## Rejected alternatives

- Keying the blob cache by path and revision: a path can name different bytes at different
  revisions and the same bytes at many; the object id is already the verified identity of the
  bytes and never needs invalidation.
- Persisting blobs to disk beside the parse cache: the parse cache exists so that bytes need
  not be reparsed; bytes themselves are cheap to re-read from a local Git, and the parse
  facts are what usefully survives a restart. Disk copies of every source would also outgrow
  the pinned, ephemeral snapshot model of ADR-061.
- Computing the fingerprint before reading blobs, to skip the reads on an analysis hit: the
  review must retain the capture's bytes for evidence and handoff, and with the blob cache a
  repeat read is a memory lookup, so reordering the capture would save little and put the
  read-then-fingerprint invariant at risk.
- Bounding by entry count instead of bytes: a count bound cannot hold a memory promise when
  blobs range from empty to 512 KiB. Content addressing makes zero-byte entries a non-issue:
  every empty file is one object.
- Reporting delivered bytes on the blob-read span: the span would then show 20 MiB read on a
  scan that transferred nothing, defeating the transfer-size purpose the metrics were built
  for.
- Caching live reads: the working tree has no identity until it is read; the read is the only
  way to learn what changed, so only its verified results are stored.
- Sharing the analysis cache with the History classifier: its bulk pair scans would evict the
  analyses of open reviews, and its own commit-change cache already keys the answer it keeps.
