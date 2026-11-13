;(() => {
  const SEAT_ROLES = Object.freeze({
    mayor: 'the mayor',
    'omni-pl': 'the Omni code lead',
    'omni-evals-pl': 'the evals lead',
    'city-infra-pl': 'the city infrastructure lead',
  })
  const NO_WAIT = 'Nobody has recorded what this is waiting for'
  const MINUTE_MS = 60000
  const HOUR_MS = 3600000
  const DAY_MS = 86400000

  const roleOf = (name) => SEAT_ROLES[name] ?? name
  const waitToken = (waitingOn) => (String(waitingOn ?? '').match(/[\w.-]+/)?.[0] ?? '').replace(/\.+$/, '')
  const NAME = /^[\w.-]+$/
  const NOTED = /^([^()]*?)\s*(?:\((.*)\))?$/s
  const topLevelItems = (text) => {
    const items = ['']
    let depth = 0
    for (const char of text) {
      depth += char === '(' ? 1 : char === ')' ? -1 : 0
      if (depth < 0) return null
      if (char === ',' && depth === 0) items.push('')
      else items[items.length - 1] += char
    }
    return depth === 0 ? items : null
  }
  const itemNames = (item) => {
    const text = item.trim().replace(/\.+$/, '')
    if (!text) return []
    const [, names = '', note = ''] = text.match(NOTED) ?? []
    const parts = names.split(/\s+/).filter(Boolean).map((part) => part.replace(/\.+$/, ''))
    if (parts.length === 0 || !parts.every((part) => NAME.test(part))) return null
    return parts.map((name, at) => ({ name, note: at === parts.length - 1 ? note.trim() : '' }))
  }
  const waitItems = (waitingOn) => {
    const text = String(waitingOn ?? '')
    const read = text.includes(',') ? topLevelItems(text)?.map(itemNames) : null
    const items = read && read.every(Boolean) ? read.flat() : []
    if (items.length > 1) return items
    const token = waitToken(text)
    return token ? [{ name: token, note: '' }] : []
  }
  const waitNames = (waitingOn) => waitItems(waitingOn).map((item) => item.name)
  const unit = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

  const spanWords = (ms) => {
    if (!(ms >= MINUTE_MS)) return 'under a minute'
    if (ms < HOUR_MS) return unit(Math.floor(ms / MINUTE_MS), 'minute')
    if (ms < DAY_MS) return unit(Math.floor(ms / HOUR_MS), 'hour')
    return unit(Math.floor(ms / DAY_MS), 'day')
  }

  const sinceWords = (iso, now) => spanWords(Date.parse(now) - Date.parse(iso))

  const ownerWords = (row) => {
    if (!row.owner) return 'nobody assigned'
    return row.ownerFrom === 'project lead' ? `${roleOf(row.owner)} (leads the project; nobody assigned)` : roleOf(row.owner)
  }

  const targetWords = (row) => {
    if (row.waitKind === 'her') return 'you'
    if (row.waitKind === 'decision') return 'you (a decision)'
    return row.waitTitle || SEAT_ROLES[row.waitToken] || ''
  }

  const listedName = (name, title) => name.toLowerCase() === 'stephanie' ? 'you' : title || SEAT_ROLES[name] || name

  const namedWait = (row) => {
    const names = row.waitNames ?? []
    const noted = (name, at) => row.waitNotes?.[at] ? `${name} (${row.waitNotes[at]})` : name
    if (names.length > 1) return names.map((name, at) => noted(listedName(name, row.waitNameTitles?.[at]), at)).join('; ')
    const words = targetWords(row)
    return words && row.waitToken ? row.waitingOn.replace(row.waitToken, words) : row.waitingOn
  }

  const waitWords = (row, now) => {
    const age = row.updatedAt ? sinceWords(row.updatedAt, now) : ''
    const tail = `${age ? ` for ${age}` : ''}${row.likelyBroken ? ' — likely broken' : ''}`
    if (row.waitingOn) return `${namedWait(row)}${tail}`
    if (row.waitUnreadable) return 'unknown, the wait note could not be read'
    if (row.unclaimedBy) return `a free worker in ${row.unclaimedBy}${tail}`
    if (!age) return 'nothing recorded — no movement recorded'
    return (row.stuckReasons ?? []).length > 0 ? `nothing recorded — it has not moved for ${age}` : `nothing recorded — it last moved ${age} ago`
  }

  const statusLine = (row, now) => `Owner: ${ownerWords(row)} · Waiting on: ${waitWords(row, now)}`

  const api = Object.freeze({ SEAT_ROLES, NO_WAIT, roleOf, waitToken, waitItems, waitNames, spanWords, sinceWords, ownerWords, waitWords, statusLine })
  if (typeof module === 'object') module.exports = api
  else window.cardWords = api
})()
