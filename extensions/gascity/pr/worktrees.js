/* global window, module */
/**
 * Which worktree of this repository has a branch checked out, from `git worktree list
 * --porcelain`. gh pr checkout fails when the branch is already checked out elsewhere, so the
 * pull view points at that worktree instead of offering the checkout, and the list offers a
 * terminal there. hvir gives extensions no way to select another workspace yet.
 */
;(() => {
  const WORKTREE_ARGS = Object.freeze(['worktree', 'list', '--porcelain'])

  /** Branch name to worktree path, for every worktree with a branch checked out. */
  function worktreesByBranch(porcelain) {
    const byBranch = new Map()
    for (const block of porcelain.split('\n\n')) {
      const lines = block.split('\n')
      const path = lines
        .find((line) => line.startsWith('worktree '))
        ?.slice('worktree '.length)
      const branch = lines
        .find((line) => line.startsWith('branch refs/heads/'))
        ?.slice('branch refs/heads/'.length)
      if (path !== undefined && branch !== undefined) byBranch.set(branch, path)
    }
    return byBranch
  }

  /** The worktree path holding `branch`, or undefined when no worktree has it. */
  const worktreeOf = (porcelain, branch) => worktreesByBranch(porcelain).get(branch)

  /** Every worktree path in the listing. */
  const worktreePaths = (porcelain) =>
    porcelain
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))

  /**
   * sh arguments that start the person's login shell inside `path`. The path is a positional
   * argument, never part of the script, so no quoting of it is needed.
   */
  const shellArgs = (path) => [
    '-c',
    'cd -- "$1" && exec "${SHELL:-/bin/sh}" -l',
    'hvir-worktree',
    path,
  ]

  const BRANCH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._+@-]*$/
  const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

  function isPullBranch(branch) {
    if (typeof branch !== 'string' || branch.length === 0 || branch.length > 255) return false
    return branch
      .split('/')
      .every(
        (segment) =>
          BRANCH_SEGMENT.test(segment) &&
          !segment.endsWith('.') &&
          !segment.endsWith('.lock') &&
          !segment.includes('..') &&
          !segment.includes('@{'),
      )
  }

  const PULL_WORKTREE_SCRIPT = [
    'root=$(git rev-parse --show-toplevel) || exit 1',
    'dir="$root.hvir-worktrees/pr-$1"',
    'if [ ! -d "$dir" ]; then',
    '  git fetch -- "$3" "$2" || exit 1',
    '  if git show-ref --verify --quiet "refs/heads/$2"; then git worktree add -- "$dir" "$2" || exit 1',
    '  else git worktree add --track -b "$2" -- "$dir" "refs/remotes/$3/$2" || exit 1; fi',
    'fi',
    'cd -- "$dir" && exec "${SHELL:-/bin/sh}" -l',
  ].join('\n')

  function pullWorktreeArgs(number, branch, remote = 'origin') {
    if (!Number.isSafeInteger(number) || number < 1 || number > 1_000_000_000) throw new Error('Invalid pull request number')
    if (!isPullBranch(branch)) throw new Error('Unsupported pull request branch name')
    if (!REMOTE.test(remote)) throw new Error('Unsupported git remote name')
    return ['-c', PULL_WORKTREE_SCRIPT, 'hvir-pull-worktree', String(number), branch, remote]
  }

  const api = Object.freeze({
    pullWorktreeArgs,
    isPullBranch,
    WORKTREE_ARGS,
    worktreesByBranch,
    worktreeOf,
    worktreePaths,
    shellArgs,
  })
  if (typeof module === 'object') module.exports = api
  else window.worktrees = api
})()
