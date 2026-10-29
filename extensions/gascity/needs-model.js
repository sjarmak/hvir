/* global window, module */
/**
 * The Gas City half of hvir's built-in Needs you (src/shared/beads-human.ts isOpenLabelledAsk,
 * src/main/needs-you/needs-you-service.ts readAskStore): open beads labelled for the user, with no
 * `gc.answered` metadata, from the city rig named `decisions`. The built-in hardcodes the label
 * (HUMAN_ASK_LABEL) rather than deriving the user, so this does too. Loaded by projects-load.js and node --test.
 */
;(() => {
  const NEEDS_LABEL = 'needs/stephanie'
  const ASK_RIG = 'decisions'
  /** The built-in's MAX_ITEMS_PER_SOURCE. */
  const MAX_ASKS = 50

  /** The decisions rig among rigs parsed by crewParse.parseRigList (absolute paths only), if registered. */
  const decisionsRig = (rigs) => rigs.find((rig) => rig.name === ASK_RIG)

  /** bd arguments listing the rig's open labelled beads; openAsks applies the full rule after. */
  const askArgs = (path) => [
    '-C',
    path,
    'list',
    '--json',
    '--flat',
    '--no-pager',
    '--status',
    'open',
    '--label',
    NEEDS_LABEL,
    '-n',
    '0',
  ]

  const hasLabel = (issue) =>
    (issue.labels ?? []).some((label) => label.toLowerCase() === NEEDS_LABEL)
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
    ASK_RIG,
    MAX_ASKS,
    decisionsRig,
    askArgs,
    openAsks,
  })
  if (typeof module === 'object') module.exports = api
  else window.needsModel = api
})()
