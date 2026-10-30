/* global window */
/**
 * The Pull requests list's stand-in for selecting another workspace: a row whose branch is
 * checked out in another worktree of this repository gets a control that opens a terminal there
 * (the worktree-terminal action; hvir confirms each launch).
 */
window.worktreeControl = (() => {
  const { el } = window
  const { WORKTREE_ARGS, worktreesByBranch } = window.worktrees

  /** Branch to worktree path for this checkout, minus the workspace itself; empty without git. */
  async function readWorktrees(workspace, connectors) {
    if (connectors.git !== 'supported') return new Map()
    const listing = await window.host.run('git', workspace, WORKTREE_ARGS, { text: true })
    return new Map(
      [...worktreesByBranch(listing)].filter(([, path]) => path !== workspace.root?.path),
    )
  }

  /** The other worktree holding a same-repository pull request's branch, if any. */
  const worktreeFor = (worktrees, pull, repo) =>
    pull.headRepo === repo.toLowerCase() ? worktrees.get(pull.headRef) : undefined

  async function openTerminal(path, onStatus) {
    onStatus('Waiting for your confirmation…')
    try {
      const result = await window.host.request('actions.invoke', {
        action: 'worktree-terminal',
        input: { path },
      })
      onStatus(window.terminalOutcome(result, `Opened a terminal in ${path}.`))
    } catch (error) {
      onStatus(error.message)
    }
  }

  /**
   * A chip naming the worktree; with shell approved it opens the terminal. It sits inside the row
   * button, so it stops its events from also opening the pull request.
   */
  function chip(path, shell, onStatus) {
    const name = path.split('/').at(-1)
    if (shell !== 'supported')
      return el(
        'span',
        { className: 'chip', title: `Checked out in ${path}` },
        `in ${name}`,
      )
    const control = el(
      'span',
      { className: 'chip chip-terminal', title: `Open a terminal in ${path}` },
      `▸ ${name}`,
    )
    control.setAttribute('role', 'button')
    control.tabIndex = 0
    const activate = (event) => {
      event.stopPropagation()
      event.preventDefault()
      void openTerminal(path, onStatus)
    }
    control.addEventListener('click', activate)
    control.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') activate(event)
      else event.stopPropagation()
    })
    return control
  }

  return Object.freeze({ readWorktrees, worktreeFor, chip })
})()
