/* global window */
/**
 * Reads one workspace's pull request snapshot through the gh (and optional git) connectors.
 * Runs are sequential so a view stays at one connector run at a time; the extension-wide cap is 4.
 */
window.pullsSource = (() => {
  const { run } = window.host
  const { pullsQueryArgs } = window.pullQuery
  const { parsePulls, githubRemoteRepos } = window.pullParse
  /** The panel re-resolves the repository every ten minutes (REPO_TTL_MS). */
  const REPO_TTL_MS = 10 * 60 * 1000
  const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/
  const repos = new Map()

  async function repoFor(workspace) {
    const cached = repos.get(workspace.id)
    if (cached && Date.now() - cached.at < REPO_TTL_MS) return cached.repo
    const { nameWithOwner } = await run('gh', workspace, ['repo', 'view', '--json', 'nameWithOwner'])
    if (typeof nameWithOwner !== 'string' || !REPO.test(nameWithOwner))
      throw new Error('gh repo view returned no usable owner/name')
    repos.set(workspace.id, { repo: nameWithOwner, at: Date.now() })
    return nameWithOwner
  }

  /** Current branch and GitHub remotes; undefined branch on a detached HEAD. */
  async function checkout(workspace) {
    const head = (await run('git', workspace, ['rev-parse', '--abbrev-ref', 'HEAD'], { text: true })).trim()
    const remotes = await run('git', workspace, ['remote', '-v'], { text: true })
    return { branch: head === 'HEAD' || head === '' ? undefined : head, localRepos: githubRemoteRepos(remotes) }
  }

  /** `useGit` false skips This branch: no git approval, or a caller that only counts asks. */
  async function snapshot(workspace, limit, useGit) {
    const repo = await repoFor(workspace)
    const local = useGit ? await checkout(workspace) : { branch: undefined, localRepos: new Set() }
    const response = await run('gh', workspace, pullsQueryArgs(repo, local.branch, limit))
    return { ...parsePulls(response, { repo, ...local }), gitChecked: useGit }
  }

  return Object.freeze({ snapshot })
})()
