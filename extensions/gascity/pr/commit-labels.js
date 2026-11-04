/* global window, module */
/**
 * Change-type labels on commits, read the way hvir's History reads the fleet classification
 * (src/main/architecture-review/fleet-classification.ts): a note under refs/notes/classification
 * replaces the commit message's trailers; Change-Type is required; keys match case-insensitively.
 */
;(() => {
  const NOTES_REF = 'refs/notes/classification'
  const LOG = [
    'log',
    '--no-walk=unsorted',
    '--ignore-missing',
    `--notes=${NOTES_REF}`,
    '--format=%x1e%H%x1f%(trailers:only,unfold)%x1f%N%x1f',
  ]
  const RECORD = '\x1e'
  const FIELD = '\x1f'
  const HASH = /^[a-f0-9]{40,64}$/
  const TRAILER = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/
  const CONTINUATION = /^[ \t]/
  const MAX_VALUE_LENGTH = 200
  const CONTROL = /\p{Cc}/u
  /**
   * Commits per git run. The git connector allows 128 arguments and 8 KiB of them (about 120
   * hashes); output is capped at 64 KiB, so 40 records leave about 1.6 KiB each for trailers and notes.
   */
  const LABEL_BATCH = 40

  function trailerEntries(text) {
    const entries = []
    let open = false
    for (const line of text.split('\n')) {
      const match = TRAILER.exec(line)
      if (match) {
        entries.push({ key: match[1].toLowerCase(), value: match[2] })
        open = true
      } else if (open && CONTINUATION.test(line)) {
        const previous = entries.pop()
        entries.push({ ...previous, value: `${previous.value} ${line.trim()}` })
      } else open = false
    }
    return entries
  }

  const acceptable = (value) => value.length > 0 && value.length <= MAX_VALUE_LENGTH && !CONTROL.test(value)

  function trailers(text) {
    const map = new Map()
    for (const { key, value } of trailerEntries(text)) {
      const trimmed = value.trim()
      if (acceptable(trimmed)) map.set(key, [...(map.get(key) ?? []), trimmed])
    }
    return map
  }

  const present = (key, value) => (value === undefined ? {} : { [key]: value })

  /** The classification in one trailer block or note, or undefined when it has no Change-Type. */
  function parseClassification(text) {
    const found = trailers(text)
    const first = (key) => found.get(key)?.[0]
    const type = first('change-type')
    if (type === undefined) return undefined
    return Object.freeze({
      type,
      ...present('scope', first('change-scope')),
      ...present('architectural', first('architectural')),
      ...present('behavior', first('behavior')),
      ...present('compatibility', first('compatibility')),
      ...present('risk', first('risk')),
      beads: found.get('bead') ?? [],
      ...present('classifiedBy', first('classified-by')),
    })
  }

  /** Every commit git printed, mapped to its classification (undefined when unlabeled). */
  function parseLabelLog(output) {
    const found = new Map()
    for (const record of output.split(RECORD)) {
      const [hash = '', message = '', note = ''] = record.split(FIELD)
      if (HASH.test(hash)) found.set(hash, parseClassification(note === '' ? message : note))
    }
    return found
  }

  /** Names-only config listing: no values (so no credentials), and exit 0 whatever is set. */
  const CONFIG_NAMES = ['config', '--name-only', '--list']
  const PROMISOR = /^(remote\..+\.promisor|extensions\.partialclone)$/im

  /**
   * In a partial clone, git log fetches a missing commit from the promisor remote on demand.
   * `--no-lazy-fetch` (git 2.44+) stops that; other checkouts never fetch, so only these get it
   * and older git elsewhere keeps working.
   */
  const isPartialClone = (configNames) => PROMISOR.test(configNames)

  /**
   * git log argument lists for these commits; `--ignore-missing` skips ones not in the checkout,
   * and `partialClone` adds `--no-lazy-fetch` so skipping never turns into a fetch.
   */
  function labelLogBatches(hashes, partialClone) {
    const invalid = hashes.find((hash) => typeof hash !== 'string' || !HASH.test(hash))
    if (invalid !== undefined) throw new Error(`gh returned an invalid commit id: ${String(invalid).slice(0, 80)}`)
    const batches = []
    for (let start = 0; start < hashes.length; start += LABEL_BATCH)
      batches.push([...(partialClone ? ['--no-lazy-fetch'] : []), ...LOG, ...hashes.slice(start, start + LABEL_BATCH), '--'])
    return batches
  }

  /** One row per pull request commit: labeled, unlabeled, or missing from this checkout. */
  function commitLabelRows(commits, found) {
    return commits.map((commit) => {
      const label = found.get(commit.oid)
      const state = !found.has(commit.oid) ? 'missing' : label ? 'labeled' : 'unlabeled'
      return Object.freeze({
        oid: commit.oid,
        short: commit.oid.slice(0, 7),
        headline: commit.messageHeadline ?? '',
        state,
        ...(label ? { label } : {}),
      })
    })
  }

  const isArchitectural = (label) => label.architectural?.toLowerCase() === 'architectural'

  function labelChips(label) {
    return [
      label.type,
      label.scope ? `scope: ${label.scope}` : undefined,
      isArchitectural(label) ? 'architectural' : undefined,
      label.risk ? `risk: ${label.risk}` : undefined,
    ].filter(Boolean)
  }

  const commitCount = (count) => `${count} commit${count === 1 ? '' : 's'}`

  function labelSummary(rows) {
    const labeled = rows.filter((row) => row.state === 'labeled')
    const missing = rows.filter((row) => row.state === 'missing').length
    const head = labeled.length
      ? `${labeled.filter((row) => isArchitectural(row.label)).length} of ${commitCount(rows.length)} marked architectural`
      : `No change-type labels on ${commitCount(rows.length)}`
    return missing ? `${head} · ${missing} not in this checkout` : head
  }

  const api = Object.freeze({
    parseClassification,
    parseLabelLog,
    labelLogBatches,
    commitLabelRows,
    labelChips,
    labelSummary,
    isPartialClone,
    CONFIG_NAMES,
    LABEL_BATCH,
  })
  if (typeof module === 'object') module.exports = api
  else window.commitLabels = api
})()
