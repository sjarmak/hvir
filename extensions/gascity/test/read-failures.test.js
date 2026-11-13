const { test } = require('node:test')
const assert = require('node:assert/strict')
const failures = require('../read-failures.js')
const loader = require('../projects-load.js')
const page = require('./stale-page.js')

const { EARLY, livePage, workspace, statusText } = page
const LATE = '2026-11-13T02:48:00.000Z'

const exited = (code, stderr) => {
  const error = new Error(stderr.trim().split('\n')[0])
  error.exitCode = code
  error.stderr = stderr
  return error
}

const timedOut = () => {
  const error = new Error('did not run: the refresh deadline passed')
  error.reason = 'deadline'
  error.dispatch = 'not-sent'
  error.transient = true
  return error
}

const recordOf = (live) =>
  JSON.parse(JSON.stringify(live.document.defaultView.projectsData.failureRecord(workspace.id)))

test('an entry carries the UTC time, field, command, exit code and the stderr tail', () => {
  const entry = failures.entry({
    at: Date.parse(LATE),
    field: 'decisions',
    connector: 'bd',
    args: ['-C', '/rigs/decisions', 'list', '--json'],
    error: exited(1, 'Error: dolt server restarting\nretry later\n'),
  })
  assert.deepEqual(entry, {
    time: LATE,
    field: 'decisions',
    command: 'bd -C /rigs/decisions list --json',
    exitCode: 1,
    stderr: 'Error: dolt server restarting\nretry later\n',
    message: 'Error: dolt server restarting',
  })
})

test('the stderr tail is capped and keeps the end of the output', () => {
  const stderr = `${'a'.repeat(5000)}\nlast line\n`
  const entry = failures.entry({
    at: 0,
    field: 'linked',
    connector: 'bd',
    args: [],
    error: exited(2, stderr),
  })
  assert.equal(entry.stderr.length, failures.STDERR_TAIL_CHARS)
  assert.ok(entry.stderr.endsWith('last line\n'))
})

test('a run that never exited records no exit code and its reason in place of stderr', () => {
  const entry = failures.entry({
    at: 0,
    field: 'linked',
    connector: 'bd',
    args: ['list'],
    error: timedOut(),
  })
  assert.equal(entry.exitCode, null)
  assert.equal(entry.stderr, '')
  assert.equal(entry.message, 'did not run: the refresh deadline passed')
  assert.match(failures.text(entry), /linked: did not run: the refresh deadline passed$/)
})

test('the record keeps only the last 50 entries and returns a new list', () => {
  const make = (index) => ({
    time: new Date(index * 1000).toISOString(),
    field: `f${index}`,
  })
  const first = failures.record(
    [],
    Array.from({ length: 30 }, (_, index) => make(index)),
  )
  const second = failures.record(
    first,
    Array.from({ length: 30 }, (_, index) => make(30 + index)),
  )
  assert.equal(first.length, 30)
  assert.equal(second.length, failures.MAX_ENTRIES)
  assert.equal(second[0].field, 'f10')
  assert.equal(second.at(-1).field, 'f59')
  assert.ok(Object.isFrozen(second))
})

test('the status text names the UTC time, field and first stderr line', () => {
  const entry = {
    time: LATE,
    field: 'rigs',
    stderr: '\nfatal: city not found\nmore\n',
    message: 'x',
  }
  assert.equal(
    failures.text(entry),
    'Last failed read 02:48:00 UTC, rigs: fatal: city not found',
  )
})

test('keepLastGood stays pure: same inputs give the same output and inputs are not touched', () => {
  const deepFreeze = (value) => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(deepFreeze)
      Object.freeze(value)
    }
    return value
  }
  const payload = deepFreeze({
    now: LATE,
    unread: ['linked'],
    projects: [],
    sessions: [],
    outcomes: [],
  })
  const lastGood = deepFreeze({
    board: { values: { projects: [{ id: 'pj-1' }] }, at: EARLY },
  })
  const once = loader.keepLastGood({ payload, lastGood })
  const twice = loader.keepLastGood({ payload, lastGood })
  assert.deepEqual(once, twice)
  assert.equal(JSON.stringify(once).includes('stderr'), false)
})

test('a failed decisions read is recorded and shown in the status line', async (t) => {
  const live = livePage(t)
  await live.load()
  live.at(LATE)
  live.failing = page.isDecisions
  live.bdError = () => exited(1, 'Error: decisions store locked\n')
  await live.load()
  const entries = recordOf(live)
  const entry = entries.find((item) => item.field === 'decisions')
  assert.equal(entry.time, LATE)
  assert.match(entry.command, /^bd -C \/rigs\/decisions list /)
  assert.equal(entry.exitCode, 1)
  assert.equal(entry.stderr, 'Error: decisions store locked\n')
  assert.match(
    statusText(live.document),
    /Last failed read 02:48:00 UTC, decisions: Error: decisions store locked/,
  )
})

test('a timed-out linked read is recorded and shown in the status line', async (t) => {
  const live = livePage(t)
  await live.load()
  live.at(LATE)
  live.failing = page.isLinked
  live.bdError = timedOut
  await live.load()
  const entry = recordOf(live).find((item) => item.field === 'linked')
  assert.ok(entry.command.startsWith('bd -C '))
  assert.ok(entry.command.includes('--has-metadata-key'))
  assert.equal(entry.exitCode, null)
  assert.equal(entry.message, 'did not run: the refresh deadline passed')
  assert.match(
    statusText(live.document),
    /Last failed read 02:48:00 UTC, linked: did not run: the refresh deadline passed/,
  )
})

test('a rig-list failure is recorded with the gc command and shown in the status line', async (t) => {
  const live = livePage(t)
  await live.load()
  live.at(LATE)
  live.rigListFailing = true
  live.rigListError = () => exited(3, 'gc: city.toml unreadable\nat /city/city.toml\n')
  await live.load()
  const entry = recordOf(live).find((item) => item.field === 'rigs')
  assert.deepEqual(entry, {
    time: LATE,
    field: 'rigs',
    command: 'gc rig list --json',
    exitCode: 3,
    stderr: 'gc: city.toml unreadable\nat /city/city.toml\n',
    message: 'gc: city.toml unreadable',
  })
  assert.match(
    statusText(live.document),
    /Last failed read 02:48:00 UTC, rigs: gc: city.toml unreadable/,
  )
})

test('a clean refresh keeps the record but clears the warning', async (t) => {
  const live = livePage(t)
  await live.load()
  live.at(LATE)
  live.failing = page.isLinked
  await live.load()
  assert.match(statusText(live.document), /Last failed read/)
  const kept = recordOf(live)
  live.at('2026-11-13T02:50:00.000Z')
  live.failing = () => false
  await live.load()
  assert.doesNotMatch(statusText(live.document), /Last failed read/)
  assert.deepEqual(recordOf(live), kept)
})

test('the pane record stays bounded across many failed refreshes', async (t) => {
  const live = livePage(t)
  live.failing = () => true
  for (let minute = 0; minute < 12; minute += 1) {
    live.after(minute)
    await live.load()
  }
  const entries = recordOf(live)
  assert.equal(entries.length, failures.MAX_ENTRIES)
  assert.equal(
    entries.at(-1).time,
    new Date(Date.parse(EARLY) + 11 * 60000).toISOString(),
  )
})
