const { test } = require('node:test')
const assert = require('node:assert/strict')
const { pullStacks } = require('../pull-stacks.js')

const pull = (number, headRef, baseRef, fields = {}) => ({
  number,
  headRef,
  baseRef,
  headRepo: 'acme/widgets',
  state: 'open',
  ...fields,
})

test('a forked stack walks depth first from the base and numbers every member', () => {
  const stacks = pullStacks(
    [pull(10, 'a', 'main'), pull(12, 'c', 'a'), pull(11, 'b', 'a'), pull(13, 'd', 'b'), pull(20, 'solo', 'main')],
    'acme/widgets',
  )
  assert.deepEqual(stacks.get(10).order, [10, 11, 13, 12])
  assert.deepEqual(
    [10, 11, 13, 12].map((number) => [stacks.get(number).position, stacks.get(number).depth, stacks.get(number).parent]),
    [
      [0, 0, undefined],
      [1, 1, 10],
      [2, 2, 11],
      [3, 1, 10],
    ],
  )
  assert.equal(stacks.has(20), false)
})

test('a head in a fork, a closed parent and a branch cycle form no stack', () => {
  const fork = pullStacks([pull(10, 'a', 'main', { headRepo: 'rin/widgets' }), pull(11, 'b', 'a')], 'acme/widgets')
  assert.equal(fork.size, 0)
  const closed = pullStacks([pull(10, 'a', 'main', { state: 'merged' }), pull(11, 'b', 'a')], 'acme/widgets')
  assert.equal(closed.size, 0)
  const cycle = pullStacks([pull(10, 'a', 'b'), pull(11, 'b', 'a')], 'Acme/Widgets')
  assert.equal(cycle.size, 0)
})

test('separate stacks get separate ids', () => {
  const stacks = pullStacks([pull(10, 'a', 'main'), pull(11, 'b', 'a'), pull(30, 'x', 'main'), pull(31, 'y', 'x')], 'acme/widgets')
  assert.notEqual(stacks.get(11).id, stacks.get(31).id)
  assert.deepEqual(stacks.get(31).order, [30, 31])
})
