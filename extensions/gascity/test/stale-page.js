const { readFileSync } = require('node:fs')

const EARLY = '2026-11-13T02:43:00.000Z'
const MINUTE = 60000

const workspace = {
  id: 'city',
  host: 'ssh-test',
  root: { host: 'ssh-test', path: '/city' },
}
const rigs = [
  { name: 'city', path: '/city', hq: true },
  { name: 'lead', path: '/rigs/lead' },
  { name: 'decisions', path: '/rigs/decisions' },
]
const baseProject = () => ({
  id: 'pj-1',
  title: 'Lantern catalog',
  status: 'open',
  labels: ['city-project'],
  metadata: { 'proj.lead': 'lead-a', 'proj.state': 'waiting', 'proj.waiting_on': 'wk-1' },
})
const baseWork = (page) => ({
  id: 'wk-1',
  title: 'Index rebuild',
  status: 'open',
  priority: 1,
  updated_at: new Date(page.clock).toISOString(),
  metadata: { 'proj.id': 'pj-1', 'gc.waiting_on': 'lead-a' },
})

const isLabeled = (args) => args.includes('--label-any')
const isLinked = (args) =>
  args.includes('--has-metadata-key') &&
  args.includes('open,in_progress,blocked,deferred')
const isInProgress = (args) =>
  args.includes('in_progress') && args.includes('--all') && !isLabeled(args)
const isUrgent = (args) => args.includes('--priority-max')
const isHerSteps = (args) =>
  args[1] === '/rigs/decisions' && args.includes('needs/stephanie-step')
const isDecisionRig = (args) =>
  args[1] === '/rigs/decisions' &&
  !isLabeled(args) &&
  !isLinked(args) &&
  !isUrgent(args) &&
  !isInProgress(args)
const isDecisions = (args) => isDecisionRig(args) && !isHerSteps(args)
const isAsks = (args) => isDecisions(args) && args.includes('needs/stephanie')

const SCRIPTS = [
  'view',
  'card-words',
  'wait-model',
  'crew-parse',
  'needs-model',
  'projects-load',
  'projects-truth',
  'projects-model',
  'answer-state',
  'projects-render',
  'answer',
  'attach',
  'projects-data',
  'projects-seen',
]

const defaultRead = (page, args) => {
  if (isLabeled(args))
    return args[1] === '/city' ? [...page.projects, ...page.artifacts] : []
  if (isLinked(args) && args[1] === '/rigs/lead' && args.includes('proj.id'))
    return page.linked()
  if (isInProgress(args) && args[1] === '/rigs/lead') return page.inProgress()
  if (isAsks(args)) return page.asks
  if (isHerSteps(args)) return page.steps
  return []
}

const livePage = (t, { entry = 'projects' } = {}) => {
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM(readFileSync(`${__dirname}/../${entry}.html`, 'utf8'), {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  })
  t.after(() => dom.window.close())
  const { window } = dom
  Object.defineProperty(window, 'crypto', {
    value: require('node:crypto').webcrypto,
    configurable: true,
  })
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder, configurable: true })
  window.hvirExtension = { onMessage: () => () => {}, send: () => {} }
  for (const file of SCRIPTS)
    window.eval(readFileSync(`${__dirname}/../${file}.js`, 'utf8'))
  const page = {
    view: undefined,
    failing: () => false,
    document: window.document,
    clock: Date.parse(EARLY),
    projects: [baseProject()],
    artifacts: [],
    asks: [],
    steps: [],
    linked: () => [baseWork(page)],
    outcomes: undefined,
    outcomesFailing: false,
    inProgress: () => [],
    rigs,
    rigListFailing: false,
    bdCalls: [],
    during: () => {},
    at: (iso) => {
      page.clock = Date.parse(iso)
    },
    after: (minutes) => {
      page.clock = Date.parse(EARLY) + minutes * MINUTE
    },
    load: () => page.view.load({ workspace }),
  }
  window.Date.now = () => page.clock
  window.startView = (options) => {
    page.view = options
    return { refresh: async () => {} }
  }
  window.host = {
    availability: async () => ({
      gc: 'supported',
      bd: 'supported',
      ...(page.outcomes ? { 'city-outcomes': 'supported' } : {}),
    }),
    run: async (connector, scope, args) => {
      if (connector === 'city-outcomes') {
        if (page.outcomesFailing) throw new Error('outcomes store restarting')
        return { entries: page.outcomes }
      }
      if (args[0] !== 'rig') return { sessions: [] }
      if (page.rigListFailing) throw new Error('fake rig-list failure')
      return { rigs: page.rigs }
    },
  }
  window.bdRead = async (scope, args) => {
    page.bdCalls.push(args)
    page.during(args)
    if (page.failing(args)) throw new Error('dolt server restarting')
    return defaultRead(page, args)
  }
  window.bdNote = () => ''
  window.openOwn = async () => {}
  window.connectHandler = () => async () => {}
  window.eval(readFileSync(`${__dirname}/../${entry}.js`, 'utf8'))
  return page
}

const clock = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const dated = (iso) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
const chipOf = (document) =>
  document.querySelector('.projects-nav-row .projects-chip')?.dataset.state
const navRows = (document) => document.querySelectorAll('.projects-nav-row').length
const sectionsTitled = (document, title) =>
  [...document.querySelectorAll('section')].filter((node) =>
    node.querySelector('h2')?.textContent.startsWith(title),
  )
const waitingRows = (document) =>
  sectionsTitled(document, 'Waiting on').flatMap((node) =>
    [...node.querySelectorAll('li')].map((row) => row.title),
  )
const staleLines = (document) => [
  ...document.querySelectorAll('#projects .projects-stale'),
]
const staleLine = (document) => staleLines(document)[0] ?? null
const needsText = (document) =>
  sectionsTitled(document, 'Needs you')
    .map((node) => node.textContent)
    .join('\n')
const stepsText = (document) =>
  sectionsTitled(document, 'Your next step')
    .map((node) => node.textContent)
    .join('\n')

module.exports = {
  EARLY,
  workspace,
  isLabeled,
  isLinked,
  isInProgress,
  isUrgent,
  isDecisions,
  isHerSteps,
  livePage,
  clock,
  dated,
  chipOf,
  navRows,
  waitingRows,
  staleLines,
  staleLine,
  needsText,
  stepsText,
}
