;(() => {
  const words = typeof module === 'object' ? require('./card-words.js') : window.cardWords
  const HER = 'stephanie'
  const STEP_LABEL = 'needs/stephanie-step'
  const DEC_ID = /^dec-[a-z0-9]+$/
  const DAY_MS = 86400000
  const NAMES_SEAT = /(^|[^\w-])seats?($|[^\w-])/i

  const textOf = (value) => typeof value === 'string' ? value.trim() : ''
  const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  const routeOf = (bead) => textOf(bead?.metadata?.['gc.execution_routed_to'])
  const namesHer = (token) => token.toLowerCase() === HER

  const kindOf = (wait, isAgent) => {
    if (wait.waitsOnHer) return 'her'
    if (DEC_ID.test(wait.waitToken)) return 'decision'
    return wait.unclaimedBy || (wait.waitToken && isAgent(wait.waitToken)) || NAMES_SEAT.test(wait.waitingOn) ? 'agent' : ''
  }

  const waitOf = (bead, now, isAgent) => {
    const raw = bead?.metadata?.['gc.waiting_on']
    const stepLabel = (bead?.labels ?? []).some((label) => String(label).toLowerCase() === STEP_LABEL)
    const waitingOn = textOf(raw) || (stepLabel ? HER : '')
    const waitToken = words.waitToken(waitingOn)
    const waitNames = words.waitNames(waitingOn)
    const wait = { waitingOn, waitNames, waitUnreadable: raw !== undefined && raw !== null && typeof raw !== 'string', waitToken,
      waitsOnHer: stepLabel || waitNames.some(namesHer), unclaimedBy: !waitingOn && !bead?.assignee ? routeOf(bead) : '',
      updatedAt: validTime(bead?.updated_at) ? bead.updated_at : null }
    const waitKind = kindOf(wait, isAgent)
    return { ...wait, waitKind,
      likelyBroken: Boolean(waitKind) && wait.updatedAt !== null && Date.parse(now) - Date.parse(wait.updatedAt) > DAY_MS }
  }

  const api = Object.freeze({ HER, STEP_LABEL, routeOf, waitOf })
  if (typeof module === 'object') module.exports = api
  else window.waitModel = api
})()
