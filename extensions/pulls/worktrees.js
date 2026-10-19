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
   * zsh arguments that start the person's login shell inside `path`. The path is a positional
   * argument, never part of the script, so no quoting of it is needed.
   */
  const shellArgs = (path) => [
    '-c',
    'cd -- "$1" && exec "${SHELL:-/bin/zsh}" -l',
    'hvir-worktree',
    path,
  ]

  const api = Object.freeze({
    WORKTREE_ARGS,
    worktreesByBranch,
    worktreeOf,
    worktreePaths,
    shellArgs,
  })
  if (typeof module === 'object') module.exports = api
  else window.worktrees = api
})()
