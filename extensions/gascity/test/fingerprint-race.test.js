const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { JSDOM } = require('jsdom')

const flush = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const racePage = () => {
  const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' })
  const { window } = dom
  for (const file of ['view.js', 'needs-model.js', 'answer-state.js', 'projects-render.js'])
    window.eval(readFileSync(`${__dirname}/../${file}`, 'utf8'))
  const fingerprints = []
  window.needsModel = { ...window.needsModel, cardHash: () => {
    const pending = deferred()
    fingerprints.push(pending)
    return pending.promise
  } }
  const calls = []
  const ask = { id: 'dec-1', title: 'Choose', description: '', needsYou: true,
    metadata: { 'gc.project': 'proj-1', 'gc.options': '[{"letter":"a","text":"Yes"}]' },
    refs: { prs: [], issues: [], invalid: [] } }
  window.projectsRender.renderProjectNeeds({ needsYou: [ask] }, 'proj-1', window.document.querySelector('main'), {
    workspaceId: 'ws-1', onAnswer: (...args) => { calls.push(args); return deferred().promise },
  })
  const choice = window.document.querySelector('.projects-answer > button')
  choice.click()
  const confirm = window.document.querySelector('.projects-confirm button')
  const start = () => confirm.dispatchEvent(new window.Event('click'))
  const snapshot = () => ({ disabled: choice.disabled, calls: calls.length,
    status: window.document.querySelector('.projects-answer-outcome').textContent })
  return { fingerprints, calls, start, snapshot, close: () => window.close() }
}

const complete = async (pending, success, reason = 'stale failure') => {
  if (success) pending.resolve('a'.repeat(64))
  else pending.reject(new Error(reason))
  await flush()
}

const checkSchedule = async (order, successes) => {
  const page = racePage()
  try {
    for (let i = 1; i < order.length; i++) page.start()
    let expected = { disabled: true, calls: 0, status: '' }
    for (const index of order) {
      await complete(page.fingerprints[index], successes[index])
      if (index === order.length - 1) expected = successes[index]
        ? { disabled: true, calls: 1, status: '' }
        : { disabled: false, calls: 0, status: 'No answer was sent: stale failure' }
      assert.deepEqual(page.snapshot(), expected)
    }
  } finally {
    page.close()
  }
}

module.exports = { checkSchedule }

if (require.main === module) {
  test('a stale render fingerprint cannot unlock a pending confirmation', async (t) => {
    const page = racePage()
    t.after(page.close)
    page.start()
    await complete(page.fingerprints[0], true)
    assert.deepEqual(page.snapshot(), { disabled: true, calls: 0, status: '' })
  })

  test('the six-step race cannot unlock or relabel a dispatched answer', async (t) => {
    const page = racePage()
    t.after(page.close)
    page.start()
    await complete(page.fingerprints[0], true)
    page.start()
    await complete(page.fingerprints[2], true)
    assert.equal(page.calls.length, 1)
    const dispatched = page.snapshot()
    await complete(page.fingerprints[1], false)
    assert.deepEqual(page.snapshot(), dispatched)
    assert.equal(page.snapshot().disabled, true)
  })

  test('two rejections preserve the newer failure and retryable buttons', async (t) => {
    const page = racePage()
    t.after(page.close)
    page.start()
    await complete(page.fingerprints[1], false, 'new failure')
    await complete(page.fingerprints[0], false)
    assert.deepEqual(page.snapshot(), {
      disabled: false, calls: 0, status: 'No answer was sent: new failure',
    })
  })
}
