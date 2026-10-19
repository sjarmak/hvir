/* global window, module */
/**
 * Which worktree of this repository has a branch checked out, from `git worktree list
 * --porcelain`. gh pr checkout fails when the branch is already checked out elsewhere, so the
 * pull view points at that worktree, and can open a terminal there, instead of offering the
 * checkout. hvir gives extensions no way to select another workspace yet.
 */
;(() => {
  const WORKTREE_ARGS = Object.freeze(['worktree', 'list', '--porcelain'])

  /** The worktree path holding `branch`, or undefined when no worktree has it. */
  function worktreeOf(porcelain, branch) {
    const holder = porcelain
      .split('\n\n')
      .map((block) => block.split('\n'))
      .find((lines) => lines.includes(`branch refs/heads/${branch}`))
    return holder?.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
  }

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

  const api = Object.freeze({ WORKTREE_ARGS, worktreeOf, worktreePaths, shellArgs })
  if (typeof module === 'object') module.exports = api
  else window.worktrees = api
})()
