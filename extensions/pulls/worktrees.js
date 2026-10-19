/* global window, module */
/**
 * Which worktree of this repository has a branch checked out, from `git worktree list
 * --porcelain`. gh pr checkout fails when the branch is already checked out elsewhere, so the
 * pull view points at that worktree instead of offering the checkout.
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

  const api = Object.freeze({ WORKTREE_ARGS, worktreeOf })
  if (typeof module === 'object') module.exports = api
  else window.worktrees = api
})()
