const { test } = require('node:test')
const assert = require('node:assert/strict')
const { roleOf, spanWords, NO_WAIT, waitItems, waitNames } = require('../card-words.js')

test('seat names read as plain roles and unknown names stay as they are', () => {
  assert.deepEqual(['mayor', 'omni-pl', 'omni-evals-pl', 'city-infra-pl', 'fx-pool-2'].map(roleOf),
    ['the mayor', 'the Omni code lead', 'the evals lead', 'the city infrastructure lead', 'fx-pool-2'])
})

test('spans read in whole minutes, hours or days', () => {
  assert.equal(spanWords(30000), 'under a minute')
  assert.equal(spanWords(NaN), 'under a minute')
  assert.equal(spanWords(60000), '1 minute')
  assert.equal(spanWords(28 * 60000), '28 minutes')
  assert.equal(spanWords(3600000), '1 hour')
  assert.equal(spanWords(23.9 * 3600000), '23 hours')
  assert.equal(spanWords(2 * 86400000 + 5), '2 days')
})

test('the missing-wait flag reads no wait recorded', () => {
  assert.equal(NO_WAIT, 'no wait recorded')
})

test('a comma-separated wait reads every item, keeping a trailing parenthesised note as that item\'s note', () => {
  assert.deepEqual(waitItems('fx-a, dec-p0q8 (her: approve), stephanie'),
    [{ name: 'fx-a', note: '' }, { name: 'dec-p0q8', note: 'her: approve' }, { name: 'stephanie', note: '' }])
  assert.deepEqual(waitItems('fx-a (blocked on x, y), Stephanie.'),
    [{ name: 'fx-a', note: 'blocked on x, y' }, { name: 'Stephanie', note: '' }])
  assert.deepEqual(waitNames('fx-dep-a,fx-dep-b, stephanie'), ['fx-dep-a', 'fx-dep-b', 'stephanie'])
  assert.deepEqual(waitNames('fx-a,, fx-b.'), ['fx-a', 'fx-b'])
})

test('a wait that is not a list of names, or whose parentheses do not close, reads as its first name', () => {
  assert.deepEqual(waitItems('omni-pl (reviewing)'), [{ name: 'omni-pl', note: '' }])
  assert.deepEqual(waitNames('fx-a (oops, stephanie'), ['fx-a'])
  assert.deepEqual(waitNames('fx-a, then ask stephanie (later'), ['fx-a'])
  assert.deepEqual(waitNames(''), [])
})
