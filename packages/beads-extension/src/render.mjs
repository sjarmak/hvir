import { beadEvalLink } from './links.mjs'

export function sectionElement(
  document,
  label,
  items,
  count,
  openExternal,
  actions,
  leading = [],
) {
  const container = document.createElement('section')
  container.className = 'beads-section'
  const heading = document.createElement('h3')
  heading.textContent = `${label} · ${count}`
  container.append(heading)
  if (!items.length && !leading.length) {
    const empty = document.createElement('p')
    empty.className = 'beads-empty'
    empty.textContent = 'None'
    container.append(empty)
    return container
  }
  const list = document.createElement('ul')
  list.className = 'beads-list'
  list.append(...leading)
  for (const item of items) list.append(rowElement(document, item, openExternal, actions))
  container.append(list)
  return container
}

export function gateElement(document, item) {
  const row = document.createElement('li')
  row.className = 'beads-row beads-gate'
  const badge = document.createElement('span')
  badge.className = 'beads-gate-badge'
  badge.textContent = `${item.gate.gateType} gate`
  const title = document.createElement('span')
  title.className = 'beads-row-title'
  title.textContent = item.gate.title
  const unlocks = document.createElement('span')
  unlocks.className = 'beads-gate-unlocks'
  const blocked =
    item.blocks ??
    (item.gate.blockedId
      ? { id: item.gate.blockedId, title: item.gate.blockedId }
      : undefined)
  unlocks.textContent = blocked ? `unblocks ${blocked.title}` : ''
  row.append(badge, title, unlocks)
  return row
}

function rowElement(document, item, openExternal, actions) {
  const row = document.createElement('li')
  row.className = 'beads-row'
  row.dataset.beadId = item.id
  const title = document.createElement('span')
  title.className = 'beads-row-title'
  title.textContent = item.title
  const details = document.createElement('span')
  details.className = 'beads-row-details'
  const evaluation = beadEvalLink(item.metadata)
  if (evaluation.kind === 'available') {
    const link = document.createElement('button')
    link.className = 'beads-external'
    link.type = 'button'
    link.dataset.externalUrl = evaluation.url
    link.title = `Open evaluation at ${evaluation.origin}`
    link.textContent = 'Evaluation'
    link.addEventListener('click', () => openExternal(evaluation.url))
    details.append(link)
  } else if (evaluation.kind === 'invalid') {
    const unavailable = document.createElement('span')
    unavailable.className = 'beads-link-unavailable'
    unavailable.textContent = 'Evaluation link unavailable'
    details.append(unavailable)
  }
  if (item.blockedBy?.length) {
    const blocked = document.createElement('span')
    blocked.className = 'beads-blockedby'
    blocked.textContent = `Blocked by: ${item.blockedBy[0].title}${
      item.blockedBy.length > 1 ? ` +${item.blockedBy.length - 1}` : ''
    }`
    details.append(blocked)
  }
  if (item.unlocksCount > 0) {
    const unlocks = document.createElement('span')
    unlocks.className = 'beads-unlocks'
    unlocks.textContent = `Unlocks ${item.unlocksCount}: ${item.unlocks
      .map((issue) => issue.title)
      .join(', ')}`
    details.append(unlocks)
  }
  if (item.nextUnblock) {
    const next = document.createElement('span')
    next.className = 'beads-next-unblock'
    next.textContent = `Next unblock: ${item.nextUnblock.action}${
      item.nextUnblock.owner ? ` — ${item.nextUnblock.owner}` : ''
    }`
    details.append(next)
  }
  const id = document.createElement('span')
  id.className = 'beads-id'
  id.textContent = item.id
  details.append(id)
  row.append(title, details, actions(item))
  return row
}
