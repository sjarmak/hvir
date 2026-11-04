/* global window, module */
;(() => {
  const BEADS = 'bd'
  const PACKAGES = 'shell'
  const LABELS = { review: 'pr-review', authored: 'pr-pipeline' }
  const LIST_LIMIT = 500
  const PACKAGE_SCRIPT = [
    'dir=$1',
    'case "$dir" in *..*) echo "refused: path has .." >&2; exit 2 ;; esac',
    'case "$dir" in "$HOME"/*/.gc/pr-pipeline/*) ;; *) echo "refused: not a city pipeline package" >&2; exit 2 ;; esac',
    '[ -d "$dir" ] || exit 0',
    'for f in "$dir/findings.json" "$dir/gate.json" "$dir/posted.json" "$dir"/reviews/round-*/*.json; do',
    '  [ -f "$f" ] || continue',
    '  r=${f#"$dir"/}; printf "%s\\t" "${r%.json}"; tr -d "\\n\\r" < "$f"; printf "\\n"',
    'done',
  ].join('\n')
  const PACKAGE_DIR =
    /^\/(?!.*\/\.\.(\/|$))[^\n]*\/\.gc\/pr-pipeline\/[A-Za-z0-9._-]+\/?$/

  const listArgs = (label) => [
    'list',
    '--json',
    '--all',
    '--label',
    label,
    '-n',
    String(LIST_LIMIT),
  ]

  function packageArgs(dir) {
    if (!PACKAGE_DIR.test(dir)) throw new Error(`Not a city pipeline package: ${dir}`)
    return ['-c', PACKAGE_SCRIPT, 'sh', dir.replace(/\/$/, '')]
  }

  const meta = (bead, key) => bead.metadata?.[key]
  const numberOf = (value) =>
    Number.isInteger(Number(value)) && value !== '' && value !== undefined
      ? Number(value)
      : undefined
  const sameRepo = (bead, repo) => {
    const beadRepo = meta(bead, 'pr.repo')
    return typeof beadRepo !== 'string' || beadRepo.toLowerCase() === repo.toLowerCase()
  }

  function pullNumberFromUrl(url) {
    const match = /\/pull\/(\d+)(?:$|[/#?])/.exec(url ?? '')
    return match ? Number(match[1]) : undefined
  }

  function postedUrls(bead) {
    return ['pr.posted_review_url', 'pr.approve_review_url']
      .map((key) => meta(bead, key))
      .filter((url) => typeof url === 'string' && url)
  }

  function summarize(bead, kind) {
    return Object.freeze({
      id: bead.id,
      kind,
      title: bead.title ?? '',
      status: bead.status ?? 'unknown',
      updatedAt: bead.updated_at ?? bead.created_at ?? '',
      round: numberOf(meta(bead, 'pr.review_round')),
      verdict: meta(bead, 'pr.review_verdict') ?? '',
      blocking: numberOf(meta(bead, 'pr.review_blocking')),
      tier: numberOf(meta(bead, 'pr.tier')),
      gate: meta(bead, 'pr.gate_result') ?? '',
      reviewedHead:
        meta(bead, 'pr.review_head') ??
        meta(bead, 'pr.review_sha') ??
        meta(bead, 'pr.gate_sha') ??
        meta(bead, 'pr.head_sha') ??
        meta(bead, 'pr.candidate_head') ??
        '',
      reviewedAt: meta(bead, 'pr.review_at') ?? meta(bead, 'pr.posted_at') ?? '',
      formula: meta(bead, 'pr.review_formula') ?? '',
      seat:
        meta(bead, 'pr.review_seat') ??
        meta(bead, 'pr.opened_by') ??
        meta(bead, 'gc.execution_routed_to') ??
        '',
      lanes: meta(bead, 'pr.review_lanes') ?? '',
      decision: meta(bead, 'pr.decision_bead') ?? '',
      packageDir: meta(bead, 'pr.package_dir') ?? '',
      posted: postedUrls(bead),
      author: meta(bead, 'pr.author') ?? '',
    })
  }

  function indexBeads(reviewBeads, authoredBeads, repo) {
    const byNumber = new Map()
    const byBranch = new Map()
    const add = (map, key, entry) => map.set(key, [...(map.get(key) ?? []), entry])
    for (const bead of reviewBeads) {
      const number = numberOf(meta(bead, 'pr.review_number'))
      if (number !== undefined && sameRepo(bead, repo))
        add(byNumber, number, summarize(bead, 'review'))
    }
    for (const bead of authoredBeads) {
      if (!sameRepo(bead, repo)) continue
      const entry = summarize(bead, 'authored')
      const number =
        numberOf(meta(bead, 'pr.number')) ?? pullNumberFromUrl(meta(bead, 'pr.url'))
      if (number !== undefined) add(byNumber, number, entry)
      else if (typeof meta(bead, 'pr.head_branch') === 'string')
        add(byBranch, meta(bead, 'pr.head_branch'), entry)
    }
    return { byNumber, byBranch }
  }

  const newestFirst = (a, b) => b.updatedAt.localeCompare(a.updatedAt)

  function runsFor(index, pull) {
    const runs = [
      ...(index.byNumber.get(pull.number) ?? []),
      ...(index.byBranch.get(pull.headRef) ?? []),
    ]
    return runs
      .filter((run, at) => runs.findIndex((other) => other.id === run.id) === at)
      .sort(newestFirst)
  }

  const VERDICT_TONES = {
    pass: 'success',
    pass_with_findings: 'warning',
    fail: 'danger',
    blocked: 'danger',
  }
  const verdictTone = (verdict) => VERDICT_TONES[verdict] ?? 'neutral'
  const verdictLabel = (verdict) =>
    verdict ? verdict.replaceAll('_', ' ') : 'no verdict yet'

  function chip(runs) {
    const [latest] = runs
    if (!latest) return undefined
    const who = latest.kind === 'review' ? 'City review' : 'City pipeline'
    const blocking = latest.blocking ? ` · ${latest.blocking} blocking` : ''
    return {
      label: `${who}: ${verdictLabel(latest.verdict)}${blocking}`,
      tone: verdictTone(latest.verdict),
    }
  }

  function parsePackage(stdout) {
    const files = new Map()
    for (const line of stdout.split('\n')) {
      const tab = line.indexOf('\t')
      if (tab < 1) continue
      try {
        files.set(line.slice(0, tab), JSON.parse(line.slice(tab + 1)))
      } catch (error) {
        files.set(line.slice(0, tab), { unreadable: error.message })
      }
    }
    const rounds = new Map()
    for (const [name, value] of files) {
      const match = /^reviews\/round-(\d+)\/([^/]+)$/.exec(name)
      if (!match) continue
      const round = Number(match[1])
      const lane = Object.freeze({
        lane: value.lane_id ?? match[2],
        model: value.model ?? '',
        verdict: value.verdict ?? '',
        blocking: numberOf(value.blocking_count),
        summary: value.summary ?? '',
        head: value.head_sha ?? '',
        findings: Array.isArray(value.findings) ? value.findings.length : 0,
        unreadable: value.unreadable,
      })
      rounds.set(
        round,
        [...(rounds.get(round) ?? []), lane].sort((a, b) => a.lane.localeCompare(b.lane)),
      )
    }
    const consolidated = files.get('findings')
    const posted = files.get('posted')
    const postedByFinding = new Map(
      (posted?.entries ?? [])
        .filter((entry) => entry.finding && entry.url)
        .map((entry) => [entry.finding, entry.url]),
    )
    const findings = (
      Array.isArray(consolidated?.findings) ? consolidated.findings : []
    ).map((finding) =>
      Object.freeze({
        id: String(finding.id ?? ''),
        severity: String(finding.severity ?? 'unknown'),
        title: String(finding.title ?? ''),
        file: typeof finding.file === 'string' ? finding.file : '',
        line: numberOf(finding.line),
        lanes: Array.isArray(finding.lanes) ? finding.lanes.map(String) : [],
        evidence:
          typeof finding.evidence === 'string'
            ? finding.evidence
            : typeof finding.body === 'string'
              ? finding.body
              : '',
        postedUrl: postedByFinding.get(finding.id),
      }),
    )
    return Object.freeze({
      head: consolidated?.head_sha ?? '',
      findings,
      gate: files.get('gate'),
      posted: (posted?.entries ?? []).filter((entry) => entry.url),
      rounds: [...rounds]
        .sort(([a], [b]) => b - a)
        .map(([round, lanes]) => ({ round, lanes })),
    })
  }

  function findingsByFile(findings) {
    const byFile = new Map()
    for (const finding of findings)
      if (finding.file)
        byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding])
    return byFile
  }

  const api = Object.freeze({
    BEADS,
    PACKAGES,
    LABELS,
    listArgs,
    packageArgs,
    indexBeads,
    runsFor,
    chip,
    verdictTone,
    verdictLabel,
    parsePackage,
    findingsByFile,
  })
  if (typeof module === 'object') module.exports = api
  else window.cityReviews = api
})()
