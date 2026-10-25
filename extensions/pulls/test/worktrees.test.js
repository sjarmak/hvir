const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  chmodSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { worktreeOf, worktreePaths, shellArgs } = require('../worktrees.js')

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

test('worktreePaths lists every worktree, detached ones included', () => {
  assert.deepEqual(worktreePaths(PORCELAIN), [
    '/Users/me/omni',
    '/Users/me/omni.hvir-worktrees/pr-67953',
    '/Users/me/omni.hvir-worktrees/detached',
  ])
})

test('shellArgs starts the login shell in a path with spaces and quotes, never running it as code', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'wt-')))
  const path = join(base, `it's a "$(touch pwned)" dir`)
  mkdirSync(path)
  const fakeShell = join(base, 'fake-shell')
  writeFileSync(fakeShell, '#!/bin/sh\npwd\n')
  chmodSync(fakeShell, 0o755)
  const out = execFileSync('sh', shellArgs(path), {
    cwd: base,
    env: { ...process.env, SHELL: fakeShell },
    encoding: 'utf8',
  })
  assert.equal(out.trim(), path)
  assert.throws(() => execFileSync('ls', [join(base, 'pwned')], { stdio: 'ignore' }))
})
