/* global window, module, require */
;(() => {
  const node = typeof module === 'object'
  const { reviewName, pullPrefix, repoPrefix } = node
    ? require('./review-store.js')
    : window.reviewStore

  const EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES']
  const SIDES = ['LEFT', 'RIGHT']

  const isObject = (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

  function normalizeReview(raw) {
    if (!isObject(raw))
      return {
        read: {},
        summary: '',
        event: 'COMMENT',
        corrupt: raw !== undefined && raw !== null,
      }
    const read = isObject(raw.read)
      ? Object.fromEntries(
          Object.entries(raw.read).filter(([, hash]) => typeof hash === 'string'),
        )
      : {}
    return {
      read,
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      event: EVENTS.includes(raw.event) ? raw.event : 'COMMENT',
      corrupt: false,
    }
  }

  function normalizeDraft(raw, id) {
    if (!isObject(raw)) return undefined
    const { path, line, side, body, commit } = raw
    if (
      typeof path !== 'string' ||
      !Number.isInteger(line) ||
      line < 1 ||
      !SIDES.includes(side)
    )
      return undefined
    if (typeof body !== 'string') return undefined
    return {
      id,
      path,
      line,
      side,
      body,
      commit: typeof commit === 'string' ? commit : '',
    }
  }

  function fromListing(entries, repo, number) {
    const prefix = pullPrefix(repo, number)
    const review = normalizeReview(entries.get(reviewName(repo, number)))
    const drafts = []
    let skipped = 0
    for (const [name, value] of entries) {
      if (!name.startsWith(`${prefix}draft-`)) continue
      const draft = normalizeDraft(value, name.slice(`${prefix}draft-`.length))
      if (draft) drafts.push(draft)
      else skipped += 1
    }
    drafts.sort(
      (a, b) =>
        a.path.localeCompare(b.path) || a.line - b.line || a.id.localeCompare(b.id),
    )
    return { ...review, drafts, skipped: skipped + (review.corrupt ? 1 : 0) }
  }

  const isRead = (state, file) => state.read[file.path] === file.hash

  const withRead = (state, file, read) => {
    const rest = Object.fromEntries(
      Object.entries(state.read).filter(([path]) => path !== file.path),
    )
    return { ...state, read: read ? { ...rest, [file.path]: file.hash } : rest }
  }

  function progress(state, files) {
    const read = files.filter((file) => isRead(state, file)).length
    return { read, total: files.length }
  }

  function nextUnread(state, files, fromPath) {
    const start = files.findIndex((file) => file.path === fromPath)
    const ordered = [...files.slice(start + 1), ...files.slice(0, Math.max(start, 0))]
    return ordered.find((file) => !isRead(state, file))
  }

  function savedReview(state, files = []) {
    const paths = new Set(files.map((file) => file.path))
    const read = files.length
      ? Object.fromEntries(Object.entries(state.read).filter(([path]) => paths.has(path)))
      : state.read
    return { read, summary: state.summary, event: state.event }
  }

  function newDraftId(now = Date.now(), random = Math.random) {
    return `${now.toString(36)}${Math.floor(random() * 36 ** 4)
      .toString(36)
      .padStart(4, '0')}`
  }

  const savedDraft = ({ path, line, side, body, commit }) => ({
    path,
    line,
    side,
    body,
    commit,
  })

  function repoProgress(entries, repo) {
    const byNumber = new Map()
    const prefix = repoPrefix(repo)
    for (const [name, value] of entries) {
      if (!name.startsWith(prefix)) continue
      const [number, kind] = name.slice(prefix.length).split('+')
      if (!/^\d+$/.test(number ?? '')) continue
      const current = byNumber.get(Number(number)) ?? { read: {}, drafts: 0 }
      if (kind === 'review')
        byNumber.set(Number(number), { ...current, read: normalizeReview(value).read })
      else if (kind?.startsWith('draft-') && normalizeDraft(value, kind))
        byNumber.set(Number(number), { ...current, drafts: current.drafts + 1 })
    }
    return byNumber
  }

  const api = Object.freeze({
    fromListing,
    isRead,
    withRead,
    progress,
    nextUnread,
    savedReview,
    savedDraft,
    newDraftId,
    repoProgress,
  })
  if (node) module.exports = api
  else window.reviewState = api
})()
