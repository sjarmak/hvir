/* global window, module */
;(() => {
  const BEADS = 'bd'
  const LOCATOR = 'shell'
  const LIST_LIMIT = 500
  const LOCATE_SCRIPT = [
    'f=.beads/routes.jsonl',
    '[ -f "$f" ] || exit 0',
    `sed -n 's/.*"path" *: *"\\([^"]*\\)".*/\\1/p' "$f" | while IFS= read -r p; do`,
    '  [ "$p" = . ] && continue',
    '  [ -f "$p/city.toml" ] && [ -d "$p/.beads" ] && (cd "$p" && pwd -P)',
    'done',
    'exit 0',
  ].join('\n')
  const STORE_DIR = /^\/[^\n\0]*$/

  const locateArgs = () => ['-c', LOCATE_SCRIPT, 'sh']

  function parseStores(stdout) {
    const dirs = stdout.split('\n').map((line) => line.trim()).filter((line) => STORE_DIR.test(line))
    return [...new Set(dirs)]
  }

  function listArgs(dir) {
    if (!STORE_DIR.test(dir)) throw new Error(`Not an absolute city store path: ${dir}`)
    return [
      '-C',
      dir,
      'list',
      '--json',
      '--all',
      '--has-metadata-key',
      'pr.number',
      '-n',
      String(LIST_LIMIT),
    ]
  }

  const meta = (bead, key) => bead.metadata?.[key]

  const commentCount = (ids) =>
    typeof ids === 'string' ? ids.split(/[\s,]+/).filter(Boolean).length : 0

  function kindOf(bead) {
    if (meta(bead, 'pr.comment_ids') !== undefined) return 'comments'
    if (meta(bead, 'pr.head_sha') !== undefined) return 'ci'
    return 'other'
  }

  function summarize(bead) {
    const kind = kindOf(bead)
    return Object.freeze({
      id: bead.id,
      kind,
      title: bead.title ?? '',
      status: bead.status ?? 'unknown',
      updatedAt: bead.updated_at ?? bead.created_at ?? '',
      head: kind === 'ci' ? String(meta(bead, 'pr.head_sha')) : '',
      comments: kind === 'comments' ? commentCount(meta(bead, 'pr.comment_ids')) : 0,
    })
  }

  function indexFollowups(beads, repo) {
    const byNumber = new Map()
    for (const bead of beads) {
      const number = Number(meta(bead, 'pr.number'))
      if (!Number.isInteger(number) || number <= 0) continue
      const beadRepo = meta(bead, 'pr.repo')
      if (typeof beadRepo === 'string' && beadRepo.toLowerCase() !== repo.toLowerCase()) continue
      byNumber.set(number, [...(byNumber.get(number) ?? []), summarize(bead)])
    }
    for (const [number, list] of byNumber)
      byNumber.set(
        number,
        [...new Map(list.map((item) => [item.id, item])).values()].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        ),
      )
    return byNumber
  }

  const isOpen = (followup) => followup.status !== 'closed'

  const KIND_LABELS = { comments: 'Open review comments', ci: 'CI failure', other: 'Follow-up' }
  const kindLabel = (kind) => KIND_LABELS[kind] ?? KIND_LABELS.other

  function chip(followups) {
    const open = followups.filter(isOpen).length
    if (!open) return undefined
    return {
      label: `City: ${open} open follow-up${open === 1 ? '' : 's'}`,
      tone: 'warning',
    }
  }

  const api = Object.freeze({
    BEADS,
    LOCATOR,
    locateArgs,
    parseStores,
    listArgs,
    indexFollowups,
    isOpen,
    kindLabel,
    chip,
  })
  if (typeof module === 'object') module.exports = api
  else window.cityFollowups = api
})()
