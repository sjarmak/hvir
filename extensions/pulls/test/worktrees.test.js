const { test } = require('node:test')
const assert = require('node:assert/strict')
const { worktreeOf } = require('../worktrees.js')

const PORCELAIN = [
  'worktree /Users/me/omni',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /Users/me/omni.hvir-worktrees/pr-67953',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/sjarmak/eval-runs-silently-mix-llms-when-a-call',
  '',
  'worktree /Users/me/omni.hvir-worktrees/detached',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
].join('\n')

test('finds the worktree holding a branch, including one with a slash in its name', () => {
  assert.equal(
    worktreeOf(PORCELAIN, 'sjarmak/eval-runs-silently-mix-llms-when-a-call'),
    '/Users/me/omni.hvir-worktrees/pr-67953',
  )
  assert.equal(worktreeOf(PORCELAIN, 'main'), '/Users/me/omni')
})

test('a branch no worktree holds, or only a prefix of one, is not checked out', () => {
  assert.equal(worktreeOf(PORCELAIN, 'feature/new'), undefined)
  assert.equal(worktreeOf(PORCELAIN, 'sjarmak/eval-runs'), undefined)
  assert.equal(worktreeOf('', 'main'), undefined)
})
