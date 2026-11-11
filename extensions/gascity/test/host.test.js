const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

/** Load host.js against a fake bridge that answers connector.status per workspace and connector.execute with `executed`. */
function loadHost(statusByWorkspace, executed) {
  const listeners = new Set()
  const sent = []
  const bridge = {
    onMessage: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    send: (message) => {
      sent.push(message)
      const value =
        message.capability === 'connector.status'
          ? statusByWorkspace[message.input?.workspace]
          : message.capability === 'connector.execute'
            ? executed
            : message.capability === 'connector.connect'
              ? { connections: [{ connector: message.input.connector, outcome: 'approved' }] }
              : undefined
      queueMicrotask(() =>
        listeners.forEach((listener) =>
          listener(
            value === undefined
              ? { kind: 'result', id: message.id, ok: false, error: 'workspace required' }
              : { kind: 'result', id: message.id, ok: true, value },
          ),
        ),
      )
    },
  }
  const window = { hvirExtension: bridge, setTimeout }
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'host.js'), 'utf8'), { window })
  return { host: window.host, sent }
}

function loadBridge(answer) {
  const listeners = new Set()
  const sent = []
  const bridge = {
    onMessage: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    send: (message) => {
      sent.push(message)
      Promise.resolve(answer(message)).then(
        (value) =>
          listeners.forEach((listener) =>
            listener({ kind: 'result', id: message.id, ok: true, value }),
          ),
        (error) =>
          listeners.forEach((listener) =>
            listener({ kind: 'result', id: message.id, ok: false, error: error.message }),
          ),
      )
    },
  }
  const window = { hvirExtension: bridge, setTimeout }
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'host.js'), 'utf8'), { window })
  return { host: window.host, sent }
}

function completed(receipt) {
  return { outcome: 'completed', receipt, code: 0, truncated: false }
}

function outputFor(message, stdoutByReceipt) {
  if (message.input.release) return {}
  const data =
    message.input.stream === 'stdout' ? stdoutByReceipt[message.input.receipt] : ''
  return { data, nextOffset: null }
}

const executes = (sent) =>
  sent.filter((message) => message.capability === 'connector.execute')
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

const LOCAL = { id: 'ws-local', host: 'local' }
const REMOTE = { id: 'ws-remote', host: 'devbox' }

test('availability asks hvir about the given workspace and reports its rows', async () => {
  const { host, sent } = loadHost({
    'ws-local': [{ connector: 'gc', availability: 'supported', host: 'local' }],
    'ws-remote': [
      {
        connector: 'gc',
        availability: 'unavailable',
        reason: 'unavailable',
        host: 'devbox',
      },
    ],
  })
  assert.equal((await host.availability({ workspace: LOCAL })).gc, 'supported')
  assert.equal((await host.availability({ workspace: REMOTE })).gc, 'unavailable')
  // host.js runs in its own vm realm, so compare its messages by value.
  assert.equal(
    JSON.stringify(sent.map((message) => message.input)),
    JSON.stringify([{ workspace: 'ws-local' }, { workspace: 'ws-remote' }]),
  )
})

test('status is cached per workspace, not shared across workspaces', async () => {
  const { host, sent } = loadHost({
    'ws-local': [{ connector: 'gc', availability: 'supported', host: 'local' }],
    'ws-remote': [{ connector: 'gc', availability: 'supported', host: 'devbox' }],
  })
  await host.availability({ workspace: LOCAL })
  await host.availability({ workspace: LOCAL })
  await host.availability({ workspace: REMOTE })
  assert.equal(
    sent.filter((message) => message.capability === 'connector.status').length,
    2,
  )
})

test('connecting drops the cached status so the next availability asks again', async () => {
  const statuses = { 'ws-local': [{ connector: 'gc', availability: 'unavailable', host: 'local' }] }
  const { host, sent } = loadHost(statuses)
  assert.equal((await host.availability({ workspace: LOCAL })).gc, 'unavailable')
  statuses['ws-local'] = [{ connector: 'gc', availability: 'supported', host: 'local' }]
  await host.connect('gc')
  assert.equal((await host.availability({ workspace: LOCAL })).gc, 'supported')
  assert.equal(sent.filter((message) => message.capability === 'connector.status').length, 2)
})

test('runs at most three connector executions at once and queues the rest', async () => {
  const pending = []
  let receipts = 0
  const { host, sent } = loadBridge((message) => {
    if (message.capability === 'connector.execute')
      return new Promise((resolve) =>
        pending.push(() => resolve(completed(`r${++receipts}`))),
      )
    return outputFor(
      message,
      Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`r${n}`, `{"n":${n}}`])),
    )
  })
  const runs = [1, 2, 3, 4, 5].map(() => host.run('gc', LOCAL, ['status']))
  await settle()
  assert.equal(executes(sent).length, 3)
  pending.splice(0).forEach((start) => start())
  await settle()
  assert.equal(executes(sent).length, 5)
  pending.splice(0).forEach((start) => start())
  assert.deepEqual(
    (await Promise.all(runs)).map((value) => value.n).sort(),
    [1, 2, 3, 4, 5],
  )
})

test("a capacity refusal is retried after hvir's retryAfterMs until it completes", async () => {
  let refusals = 0
  const { host, sent } = loadBridge((message) => {
    if (message.capability === 'connector.execute')
      return refusals++ < 2
        ? { outcome: 'unavailable', reason: 'capacity', retryAfterMs: 1 }
        : completed('r1')
    return outputFor(message, { r1: '{"ok":true}' })
  })
  assert.equal(JSON.stringify(await host.run('gc', LOCAL, ['status'])), '{"ok":true}')
  assert.equal(executes(sent).length, 3)
})

const clocked = (answer) => {
  let clock = 0
  const waits = []
  const listeners = new Set()
  const sent = []
  const bridge = {
    onMessage: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    send: (message) => {
      sent.push(message)
      Promise.resolve(answer(message)).then((value) =>
        listeners.forEach((listener) => listener({ kind: 'result', id: message.id, ok: true, value })))
    },
  }
  const window = {
    hvirExtension: bridge,
    setTimeout: (callback, ms) => { waits.push(ms); clock += ms; setImmediate(callback) },
  }
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'host.js'), 'utf8'), { window, Date: { now: () => clock } })
  return { host: window.host, sent, waits, elapsed: () => clock }
}

test('a capacity refusal that never clears waits out the time budget, then is reported', async () => {
  const { host, sent, elapsed } = clocked((message) =>
    message.capability === 'connector.execute'
      ? { outcome: 'unavailable', reason: 'capacity' }
      : outputFor(message, {}))
  await assert.rejects(host.run('gc', LOCAL, ['status']), (error) => {
    assert.equal(error.reason, 'capacity')
    assert.equal(error.message, 'gc did not run: capacity')
    return true
  })
  assert.ok(executes(sent).length > 7)
  assert.ok(elapsed() >= 40000 && elapsed() <= 45000)
})

test('a timer that fires after the deadline does not dispatch another attempt', async () => {
  let clock = 0
  const listeners = new Set()
  const sent = []
  const bridge = {
    onMessage: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    send: (message) => {
      sent.push(message)
      const value = message.capability === 'connector.execute'
        ? { outcome: 'unavailable', reason: 'capacity' }
        : outputFor(message, {})
      Promise.resolve(value).then((answer) =>
        listeners.forEach((listener) => listener({ kind: 'result', id: message.id, ok: true, value: answer })))
    },
  }
  const window = {
    hvirExtension: bridge,
    setTimeout: (callback, ms) => { clock += ms + 60000; setImmediate(callback) },
  }
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'host.js'), 'utf8'), { window, Date: { now: () => clock } })
  await assert.rejects(window.host.run('gc', LOCAL, ['status']), /did not run: capacity/)
  assert.equal(executes(sent).length, 1)
})

const virtual = (answer) => {
  let clock = 0
  let order = 0
  let timers = []
  const listeners = new Set()
  const sent = []
  const window = {
    hvirExtension: {
      onMessage: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      send: (message) => {
        sent.push(message)
        const { value, after = 0 } = answer(message, clock)
        window.setTimeout(() => listeners.forEach((listener) =>
          listener({ kind: 'result', id: message.id, ok: true, value })), after)
      },
    },
    setTimeout: (callback, ms) => {
      const timer = { at: clock + ms, callback, order: order += 1 }
      timers = [...timers, timer]
      return timer
    },
    clearTimeout: (timer) => { timers = timers.filter((entry) => entry !== timer) },
  }
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'host.js'), 'utf8'), { window, Date: { now: () => clock } })
  const settleAll = async (promises) => {
    let done = false
    const all = Promise.allSettled(promises).then((results) => { done = true; return results })
    while (!done) {
      await new Promise((resolve) => setImmediate(resolve))
      if (done) break
      const next = [...timers].sort((a, b) => a.at - b.at || a.order - b.order)[0]
      if (!next) continue
      timers = timers.filter((entry) => entry !== next)
      clock = Math.max(clock, next.at)
      next.callback()
    }
    return all
  }
  return { host: window.host, sent, elapsed: () => clock, settleAll }
}

const slowReads = (delay) => (message) => {
  if (message.capability !== 'connector.execute') return { value: outputFor(message, { r1: '[]' }) }
  return { value: completed('r1'), after: delay }
}

test('reads admitted three at a time end by the caller deadline, the rest abandoned as not run', async () => {
  const { host, sent, elapsed, settleAll } = virtual(slowReads(25000))
  const results = await settleAll(Array.from({ length: 12 }, () =>
    host.run('bd', LOCAL, ['list'], { deadline: 60000 })))
  const fulfilled = results.filter((result) => result.status === 'fulfilled')
  const abandoned = results.filter((result) => result.status === 'rejected')
  assert.equal(fulfilled.length, 6)
  assert.equal(abandoned.length, 6)
  assert.ok(abandoned.every((result) => result.reason.reason === 'deadline' && result.reason.transient))
  assert.ok(elapsed() <= 60000)
  assert.equal(executes(sent).length, 9)
})

test('a read abandoned before its result arrives pages no output but still releases the receipt', async () => {
  const { host, sent, settleAll } = virtual(slowReads(25000))
  const [result] = await settleAll([host.run('bd', LOCAL, ['list'], { deadline: 10000 })])
  assert.equal(result.status, 'rejected')
  await settleAll([new Promise((resolve) => setTimeout(resolve, 5))])
  const outputs = sent.filter((message) => message.capability === 'connector.output')
  assert.deepEqual(outputs.map((message) => Boolean(message.input.release)), [true])
})

test('an expired deadline sends nothing, including a first attempt', async () => {
  const { host, sent, settleAll } = virtual(slowReads(0))
  const [result] = await settleAll([host.run('bd', LOCAL, ['list'], { deadline: 0 })])
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason.reason, 'deadline')
  assert.equal(executes(sent).length, 0)
})

test('a caller deadline ends retries before the default budget', async () => {
  const { host, elapsed, settleAll } = virtual((message) => message.capability === 'connector.execute'
    ? { value: { outcome: 'unavailable', reason: 'capacity' } }
    : { value: outputFor(message, {}) })
  const [result] = await settleAll([host.run('gc', LOCAL, ['status'], { deadline: 3000 })])
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason.transient, true)
  assert.ok(elapsed() <= 3000)
})

test('a capacity refusal that clears after thirty seconds still completes', async () => {
  const { host, sent, elapsed } = clocked((message) => {
    if (message.capability !== 'connector.execute') return outputFor(message, { r1: '{"ok":true}' })
    return elapsed() < 30000 ? { outcome: 'unavailable', reason: 'capacity' } : completed('r1')
  })
  assert.equal(JSON.stringify(await host.run('gc', LOCAL, ['status'])), '{"ok":true}')
  assert.ok(executes(sent).length > 7)
})

test('backoff between refusals is capped at two seconds and honours retryAfterMs', async () => {
  let refusals = 0
  const { host, waits } = clocked((message) => {
    if (message.capability !== 'connector.execute') return outputFor(message, { r1: '{}' })
    refusals += 1
    if (refusals === 1) return { outcome: 'unavailable', reason: 'capacity', retryAfterMs: 3500 }
    return refusals < 12 ? { outcome: 'unavailable', reason: 'frequency' } : completed('r1')
  })
  await host.run('gc', LOCAL, ['status'])
  assert.equal(waits[0], 3500)
  assert.ok(waits.slice(1).every((ms) => ms <= 2000))
  assert.equal(waits.at(-1), 2000)
})

test('other refusals are not retried', async () => {
  const { host, sent } = loadBridge((message) => {
    if (message.capability === 'connector.execute')
      return { outcome: 'unavailable', reason: 'disconnected' }
    return outputFor(message, {})
  })
  await assert.rejects(host.run('gc', LOCAL, ['status']), /did not run: disconnected/)
  assert.equal(executes(sent).length, 1)
})

for (const [reason, transient] of [
  ['frequency', true],
  ['capacity', true],
  ['unapproved', false],
]) {
  test(`a run hvir did not start for ${reason} is ${transient ? '' : 'not '}transient`, async () => {
    const { host } = loadHost(
      {},
      { outcome: 'not-started', reason, host: 'local', retryAfterMs: 1 },
    )
    await assert.rejects(host.run('gc', LOCAL, ['--version']), (error) => {
      assert.equal(error.reason, reason)
      assert.equal(error.transient, transient)
      return true
    })
  })
}

test("a frequency refusal is retried after hvir's retryAfterMs", async () => {
  let refusals = 0
  const { host, sent } = loadBridge((message) => {
    if (message.capability === 'connector.execute')
      return refusals++ < 1
        ? { outcome: 'not-started', reason: 'frequency', retryAfterMs: 1 }
        : completed('r1')
    return outputFor(message, { r1: '{"ok":true}' })
  })
  assert.equal(JSON.stringify(await host.run('gc', LOCAL, ['x'])), '{"ok":true}')
  assert.equal(executes(sent).length, 2)
})

test('stderr is read only when the program fails', async () => {
  const streams = (sent) =>
    sent.filter((message) => message.capability === 'connector.output' && !message.input.release)
      .map((message) => message.input.stream)
  const ok = loadBridge((message) =>
    message.capability === 'connector.execute' ? completed('r1') : outputFor(message, { r1: '{}' }))
  await ok.host.run('gc', LOCAL, ['x'])
  assert.deepEqual(streams(ok.sent), ['stdout'])
  const failed = loadBridge((message) => {
    if (message.capability === 'connector.execute') return { ...completed('r2'), code: 1 }
    if (message.input.release) return {}
    return { data: message.input.stream === 'stderr' ? 'first\nboom\n' : '', nextOffset: null }
  })
  await assert.rejects(failed.host.run('gc', LOCAL, ['x']), /first|boom/)
  assert.deepEqual(streams(failed.sent), ['stdout', 'stderr'])
})

test('run with exit returns the exit code and both streams instead of throwing, and carries the action id', async () => {
  const stdout = { r1: 'Refused: card changed.\n' }
  const { host, sent } = loadBridge((message) => {
    if (message.capability === 'connector.execute') return { outcome: 'completed', receipt: 'r1', code: 2, truncated: false }
    if (message.capability === 'connector.output' && message.input.release) return {}
    return { data: message.input.stream === 'stdout' ? stdout.r1 : 'warn\n', nextOffset: null }
  })
  const result = await host.run('hvir-answer', { id: 'w', host: 'local' }, ['dec-a1', 'a', 'f'.repeat(64)], { exit: true, actionId: 'inv-3' })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { exitCode: 2, stdout: 'Refused: card changed.\n', stderr: 'warn\n' })
  assert.ok(sent.every((message) => message.actionId === 'inv-3'))
})

test('run without exit still throws on a nonzero exit and sends no action id', async () => {
  const { host, sent } = loadBridge((message) => {
    if (message.capability === 'connector.execute') return { outcome: 'completed', receipt: 'r1', code: 1, truncated: false }
    if (message.capability === 'connector.output' && message.input.release) return {}
    return { data: message.input.stream === 'stdout' ? '' : 'boom\n', nextOffset: null }
  })
  await assert.rejects(host.run('gc', { id: 'w', host: 'local' }, []), /boom/)
  assert.ok(sent.every((message) => !('actionId' in message)))
})

test('an interruption after dispatch is tagged unknown, never not-sent', async () => {
  const { host } = loadBridge((message) =>
    message.capability === 'connector.execute'
      ? { outcome: 'interrupted-uncertain', reason: 'transport', host: 'local' }
      : outputFor(message, {}))
  await assert.rejects(host.run('hvir-answer', LOCAL, ['dec-a', 'a', 'c'], { exit: true }), (error) => {
    assert.equal(error.dispatch, 'unknown')
    assert.doesNotMatch(error.message, /did not run/)
    assert.equal(error.reason, 'transport')
    return true
  })
})

test('a completed run whose output cannot be read is tagged unknown', async () => {
  const { host } = loadBridge((message) => {
    if (message.capability === 'connector.execute') return completed('r1')
    if (message.input.release) return {}
    throw new Error('output expired')
  })
  await assert.rejects(host.run('hvir-answer', LOCAL, ['dec-a', 'a', 'c'], { exit: true }), (error) => {
    assert.equal(error.dispatch, 'unknown')
    assert.match(error.message, /output expired/)
    return true
  })
})

test('a definite refusal before dispatch is tagged not-sent', async () => {
  for (const outcome of ['not-started', 'unavailable']) {
    const { host } = loadBridge((message) =>
      message.capability === 'connector.execute'
        ? { outcome, reason: 'unapproved', host: 'local' }
        : outputFor(message, {}))
    await assert.rejects(host.run('hvir-answer', LOCAL, [], { exit: true }), (error) => {
      assert.equal(error.dispatch, 'not-sent')
      assert.match(error.message, /did not run/)
      return true
    })
  }
})

test('an outcome hvir does not name is tagged unknown', async () => {
  const { host } = loadBridge((message) =>
    message.capability === 'connector.execute' ? { outcome: 'mystery' } : outputFor(message, {}))
  await assert.rejects(host.run('hvir-answer', LOCAL, [], { exit: true }), (error) => error.dispatch === 'unknown')
})

test('a real nonzero exit is returned, not thrown, in exit mode', async () => {
  const { host } = loadBridge((message) =>
    message.capability === 'connector.execute'
      ? { outcome: 'completed', receipt: 'r1', code: 2, truncated: false }
      : outputFor(message, { r1: 'Card changed.\n' }))
  const value = await host.run('hvir-answer', LOCAL, [], { exit: true })
  assert.equal(value.exitCode, 2)
})
