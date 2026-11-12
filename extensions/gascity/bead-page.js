;(() => {
  const words = typeof module === 'object' ? require('./card-words.js') : window.cardWords
  const STATUS_WORDS = Object.freeze({ open: 'Open', in_progress: 'In progress', blocked: 'Blocked', deferred: 'Deferred', closed: 'Closed' })
  const DEC_ID = /^dec-[a-z0-9]+$/
  const HER = 'stephanie'
  const STEP_LABEL = 'needs/stephanie-step'
  const DAY_MS = 86400000
  const COMMENT_CAP = 10
  const HEADING = /^#{1,6}\s+(.*)$/
  const BULLET = /^(?:[-*]|\d+[.)])\s+(.*)$/
  const LABEL = /^([A-Z][A-Za-z ]{0,40}):\s*(.*)$/
  const RECORD_WARNING = 'The card text record could not be read, so this page shows the raw notes'

  const textBlocks = (raw) => {
    const blocks = []
    let para = []
    let items = []
    const flush = () => {
      if (para.length) blocks.push({ kind: 'para', text: para.join(' ') })
      if (items.length) blocks.push({ kind: 'list', items })
      para = []
      items = []
    }
    for (const line of String(raw ?? '').split(/\r?\n/).map((entry) => entry.trim())) {
      const heading = HEADING.exec(line)
      const bullet = BULLET.exec(line)
      if (!line || heading) flush()
      if (heading) blocks.push({ kind: 'heading', text: heading[1] })
      else if (bullet) {
        if (para.length) flush()
        items = [...items, bullet[1]]
      } else if (line) {
        if (items.length) flush()
        para = [...para, line]
      }
    }
    flush()
    return blocks
  }

  const detailSections = (raw) => String(raw ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .reduce((sections, line) => {
      const label = LABEL.exec(line)
      if (label) return [...sections, { heading: label[1], text: label[2] }]
      if (!sections.length) return [{ heading: 'Summary', text: line }]
      const last = sections[sections.length - 1]
      return [...sections.slice(0, -1), { ...last, text: last.text ? `${last.text} ${line}` : line }]
    }, [])

  const metaText = (issue, key) => typeof issue.metadata?.[key] === 'string' ? issue.metadata[key].trim() : ''
  const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))

  const waitKind = (stepLabel, waitingOn, token, unclaimedBy) => {
    if (stepLabel || waitingOn.toLowerCase().startsWith(HER)) return 'her'
    if (DEC_ID.test(token)) return 'decision'
    return unclaimedBy || words.SEAT_ROLES[token] ? 'agent' : ''
  }

  const waitRow = (issue, now) => {
    const stepLabel = (issue.labels ?? []).some((label) => String(label).toLowerCase() === STEP_LABEL)
    const waitingOn = metaText(issue, 'gc.waiting_on') || (stepLabel ? HER : '')
    const token = words.waitToken(waitingOn)
    const unclaimedBy = !waitingOn && !issue.assignee ? metaText(issue, 'gc.execution_routed_to') : ''
    const kind = waitKind(stepLabel, waitingOn, token, unclaimedBy)
    const updatedAt = validTime(issue.updated_at) ? issue.updated_at : null
    return { waitingOn, waitKind: kind, waitToken: token, waitTitle: '', unclaimedBy, updatedAt, stuckReasons: [],
      likelyBroken: Boolean(kind) && updatedAt !== null && Date.parse(now) - Date.parse(updatedAt) > DAY_MS }
  }

  const statusWords = (issue, now) => {
    const state = STATUS_WORDS[issue.status] ?? String(issue.status ?? 'Status not recorded')
    return validTime(issue.updated_at) ? `${state}, last moved ${words.sinceWords(issue.updated_at, now)} ago` : `${state}, no movement recorded`
  }

  const stamp = (iso, now) => validTime(iso)
    ? `${new Date(Date.parse(iso)).toISOString().slice(0, 16).replace('T', ' ')}Z (${words.sinceWords(iso, now)} ago)`
    : 'time not recorded'

  const commentsOf = (issue, now) => (Array.isArray(issue.comments) ? issue.comments : [])
    .filter((entry) => entry && typeof entry.text === 'string')
    .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))
    .slice(0, COMMENT_CAP)
    .map((entry) => ({ who: entry.author ? words.roleOf(entry.author) : 'author not recorded',
      when: stamp(entry.created_at, now), blocks: textBlocks(entry.text) }))

  const pageOf = (issue, card, now) => {
    const notes = textBlocks(issue.description)
    const details = card?.details ? detailSections(card.details) : []
    return {
      lead: card?.text ?? '',
      warning: card?.invalid ? RECORD_WARNING : '',
      facts: [
        { label: 'Owner', text: issue.assignee ? words.roleOf(issue.assignee) : 'Nobody assigned' },
        { label: 'Status', text: statusWords(issue, now) },
        { label: 'Waiting on', text: words.waitWords(waitRow(issue, now), now) },
      ],
      sections: details.length
        ? details.map(({ heading, text }) => ({ heading, blocks: [{ kind: 'para', text }] }))
        : notes.length ? [{ heading: 'Notes', blocks: notes }] : [],
      comments: commentsOf(issue, now),
      original: details.length && notes.length ? notes : null,
    }
  }

  const renderBlock = (block) => {
    const el = window.el
    if (block.kind === 'heading') return el('h3', {}, block.text)
    if (block.kind === 'list') return el('ul', {}, ...block.items.map((item) => el('li', {}, item)))
    return el('p', {}, block.text)
  }

  const titled = (heading, ...children) => window.el('section', {}, window.el('h2', {}, heading), ...children)

  const renderPage = (page) => {
    const el = window.el
    return [
      page.lead && el('p', { className: 'bead-lead' }, page.lead),
      page.warning && el('p', { className: 'bead-warning' }, page.warning),
      ...page.facts.map((fact) => titled(fact.label, el('p', {}, fact.text))),
      ...page.sections.map((entry) => titled(entry.heading, ...entry.blocks.map(renderBlock))),
      page.comments.length > 0 && titled('Recent comments', el('ul', { className: 'bead-comments' },
        ...page.comments.map((entry) => el('li', {}, el('p', { className: 'hvir-meta' }, `${entry.when} · ${entry.who}`),
          ...entry.blocks.map(renderBlock))))),
    ].filter(Boolean)
  }

  const renderOriginal = (page) => page.original
    ? window.el('details', { className: 'bead-original' }, window.el('summary', {}, 'Original notes'), ...page.original.map(renderBlock))
    : null

  const api = Object.freeze({ textBlocks, detailSections, pageOf, renderPage, renderOriginal })
  if (typeof module === 'object') module.exports = api
  else window.beadPage = api
})()
