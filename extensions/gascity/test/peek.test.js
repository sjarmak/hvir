const { test } = require('node:test')
const assert = require('node:assert/strict')
const { PEEK_LINES, peekArgs, peekTail } = require('../peek.js')

test('peekArgs asks gc for the capped pane capture of one session', () => {
  assert.equal(PEEK_LINES, 60)
  assert.deepEqual(peekArgs('gc-1129956'), [
    'session',
    'peek',
    'gc-1129956',
    '--lines',
    '60',
  ])
})

test('peekTail drops trailing blank pane rows and keeps the rest', () => {
  const { text, shown, total } = peekTail('one\n  two\n\n three \n   \n\n')
  assert.equal(text, 'one\n  two\n\n three ')
  assert.equal(shown, 4)
  assert.equal(total, 4)
})

test('peekTail keeps only the last lines when the capture exceeds the cap', () => {
  const stdout = Array.from({ length: 75 }, (_, index) => `line ${index + 1}`).join('\n')
  const { text, shown, total } = peekTail(stdout, 60)
  const lines = text.split('\n')
  assert.equal(shown, 60)
  assert.equal(total, 75)
  assert.equal(lines[0], 'line 16')
  assert.equal(lines.at(-1), 'line 75')
})

test('peekTail reports an empty capture as no lines', () => {
  assert.deepEqual(peekTail(''), { text: '', shown: 0, total: 0 })
  assert.deepEqual(peekTail('\n \n'), { text: '', shown: 0, total: 0 })
})

test('peekTail normalizes CRLF pane output', () => {
  assert.equal(peekTail('a\r\nb\r\n').text, 'a\nb')
})
