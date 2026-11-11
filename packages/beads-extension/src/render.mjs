import { beadEvalLink } from './links.mjs'

export function sectionElement(document, label, items, count, openExternal, actions) {
  const container = document.createElement('section')
  container.className = 'beads-section'
  const heading = document.createElement('h3')
  heading.textContent = `${label} · ${count}`
  container.append(heading)
  if (!items.length) {
    const empty = document.createElement('p')
    empty.className = 'beads-empty'
    empty.textContent = 'None'
    container.append(empty)
    return container
  }
  const list = document.createElement('ul')
  list.className = 'beads-list'
  for (const item of items)
    list.append(rowElement(document, item, openExternal, actions))
  container.append(list)
  return container
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
  const id = document.createElement('span')
  id.className = 'beads-id'
  id.textContent = item.id
  details.append(id)
  row.append(title, details, actions(item))
  return row
}
