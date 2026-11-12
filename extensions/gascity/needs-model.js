/* global window, module */
/**
 * The Gas City half of hvir's built-in Needs you (src/shared/beads-human.ts isOpenLabelledAsk,
 * src/main/needs-you/needs-you-service.ts readAskStore): open beads labelled for the user, with no
 * `gc.answered` metadata, from the city rig named `decisions`. The built-in hardcodes the label
 * (HUMAN_ASK_LABEL) rather than deriving the user, so this does too. Loaded by projects-load.js and node --test.
 */
;(() => {
  const NEEDS_LABEL = 'needs/stephanie'
  const STEP_LABEL = 'needs/stephanie-step'
  const ASK_RIG = 'decisions'
  /** The built-in's MAX_ITEMS_PER_SOURCE. */
  const MAX_ASKS = 50

  /** The decisions rig among rigs parsed by crewParse.parseRigList (absolute paths only), if registered. */
  const decisionsRig = (rigs) => rigs.find((rig) => rig.name === ASK_RIG)

  /** bd arguments listing the rig's open labelled beads; openAsks applies the full rule after. */
  const labelArgs = (path, label) => [
    '-C',
    path,
    'list',
    '--json',
    '--flat',
    '--no-pager',
    '--status',
    'open',
    '--label',
    label,
    '-n',
    '0',
  ]
  const askArgs = (path) => labelArgs(path, NEEDS_LABEL)
  const stepArgs = (path) => labelArgs(path, STEP_LABEL)

  const labelled = (issue, wanted) =>
    (issue.labels ?? []).some((label) => label.toLowerCase() === wanted)
  const hasLabel = (issue) => labelled(issue, NEEDS_LABEL)
  const metaText = (issue, key) => {
    const value = issue.metadata?.[key]
    return typeof value === 'string' ? value.trim() : ''
  }

  const CARD_TEXTS_RECORD = 'om-p86nj8'
  const CARD_TEXTS_KEY = 'gc.card_texts'
  const CARD_DETAILS_KEY = 'gc.card_details'
  const cardMap = (entries, invalid) => Object.freeze({ map: new Map(entries), invalid })

  const parseCardTexts = (raw) => {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  const recordMap = (record, key) => {
    const raw = record?.metadata?.[key]
    if (raw === undefined) return cardMap([], false)
    const parsed = typeof raw === 'string' ? parseCardTexts(raw) : null
    if (!parsed) return cardMap([], true)
    return cardMap(Object.entries(parsed).filter(([, value]) => typeof value === 'string' && value.trim())
      .map(([id, value]) => [id, value.trim()]), false)
  }

  function cardTextRecord(beads) {
    const record = beads.find((bead) => bead.id === CARD_TEXTS_RECORD)
    const texts = recordMap(record, CARD_TEXTS_KEY)
    const details = recordMap(record, CARD_DETAILS_KEY)
    return Object.freeze({ texts: texts.map, details: details.map, invalid: texts.invalid || details.invalid })
  }

  const cardText = (issue, texts = new Map()) => metaText(issue, 'gc.card_text') || texts.get(issue?.id) || ''

  function herSteps(issues, texts = new Map()) {
    return issues
      .filter((issue) => issue.status === 'open' && labelled(issue, STEP_LABEL))
      .map((issue) => ({
        id: issue.id,
        title: typeof issue.title === 'string' ? issue.title.trim() : '',
        store: issue.store,
        step: metaText(issue, 'gc.her_step'),
        scope: metaText(issue, 'gc.scope'),
        cardText: cardText(issue, texts),
      }))
  }
  const OPTIONS_KEY = 'gc.options'
  const MAX_OPTIONS = 8
  const LETTER = /^[a-z]$/

  function parseOptions(issue) {
    const raw = issue?.metadata?.[OPTIONS_KEY]
    if (typeof raw !== 'string') return []
    let list
    try {
      list = JSON.parse(raw)
    } catch {
      return []
    }
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_OPTIONS) return []
    const options = []
    for (const entry of list) {
      const letter = entry?.letter
      const text = entry?.text
      if (typeof letter !== 'string' || !LETTER.test(letter)) return []
      if (typeof text !== 'string' || text.trim() === '') return []
      if (options.some((option) => option.letter === letter)) return []
      options.push({ letter, text })
    }
    return options
  }

  const DEC_ID = /^dec-[a-z0-9]+$/
  const CARD_SHA = /^[0-9a-f]{64}$/
  const validAnswer = (decId, letter, cardSha256) =>
    typeof decId === 'string' && DEC_ID.test(decId) &&
    typeof letter === 'string' && LETTER.test(letter) &&
    typeof cardSha256 === 'string' && CARD_SHA.test(cardSha256)

  async function cardHash(issue) {
    const description = issue?.description ?? ''
    if (typeof issue?.title !== 'string' || typeof description !== 'string') return undefined
    const bytes = new TextEncoder().encode(`${issue.title}\n${description}`)
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  const isAnswered = (issue) => (issue.metadata?.['gc.answered']?.length ?? 0) > 0
  const isOpenLabelledAsk = (issue) =>
    issue.status === 'open' && hasLabel(issue) && !isAnswered(issue)

  /** Unanswered open asks in bd's order, capped at MAX_ASKS; `total` counts every match. */
  function openAsks(issues) {
    const matches = issues.filter(isOpenLabelledAsk)
    return {
      asks: matches.slice(0, MAX_ASKS),
      total: matches.length,
      truncated: matches.length > MAX_ASKS,
    }
  }

  const api = Object.freeze({
    NEEDS_LABEL,
    STEP_LABEL,
    ASK_RIG,
    MAX_ASKS,
    decisionsRig,
    askArgs,
    stepArgs,
    openAsks,
    herSteps,
    CARD_TEXTS_RECORD,
    cardTextRecord,
    cardText,
    parseOptions,
    cardHash,
    validAnswer,
  })
  if (typeof module === 'object') module.exports = api
  else window.needsModel = api
})()
