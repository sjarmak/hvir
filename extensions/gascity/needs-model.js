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

  function herSteps(issues) {
    return issues
      .filter((issue) => issue.status === 'open' && labelled(issue, STEP_LABEL))
      .map((issue) => ({
        id: issue.id,
        title: typeof issue.title === 'string' ? issue.title.trim() : '',
        store: issue.store,
        step: metaText(issue, 'gc.her_step'),
        scope: metaText(issue, 'gc.scope'),
      }))
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
  })
  if (typeof module === 'object') module.exports = api
  else window.needsModel = api
})()
