const { test } = require('node:test')
const assert = require('node:assert/strict')
const { roleOf, spanWords, NO_WAIT } = require('../card-words.js')

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

test('the missing-wait text is a sentence she can read', () => {
  assert.equal(NO_WAIT, 'Nobody has recorded what this is waiting for')
})
