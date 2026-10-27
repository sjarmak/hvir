/* global window */
window.citySource = (() => {
  const city = window.cityReviews
  const follow = window.cityFollowups
  const INDEX_TTL_MS = 2 * 60 * 1000
  let indexes = new Map()
  let packages = new Map()
  let followupIndexes = new Map()

  async function index(workspace, repo, connectors) {
    if (connectors[city.BEADS] !== 'supported')
      return { unavailable: 'bd is not connected for this workspace' }
    const key = `${workspace.id}|${repo.toLowerCase()}`
    const cached = indexes.get(key)
    if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.value
    const [reviewBeads, authoredBeads] = await Promise.all([
      window.host.run(city.BEADS, workspace, city.listArgs(city.LABELS.review)),
      window.host.run(city.BEADS, workspace, city.listArgs(city.LABELS.authored)),
    ])
    const value = { index: city.indexBeads(reviewBeads, authoredBeads, repo) }
    indexes = new Map(indexes).set(key, { at: Date.now(), value })
    return value
  }

  async function runs(workspace, repo, pull, connectors) {
    try {
      const result = await index(workspace, repo, connectors)
      if (result.unavailable) return { runs: [], unavailable: result.unavailable }
      return { runs: city.runsFor(result.index, pull) }
    } catch (error) {
      return { runs: [], error: error.message }
    }
  }

  async function reviewPackage(workspace, run, connectors) {
    if (!run.packageDir) return { unavailable: 'This run recorded no review package.' }
    if (connectors[city.PACKAGES] !== 'supported')
      return { unavailable: 'Connect shell to read city review findings.' }
    const key = `${workspace.id}|${run.id}|${run.updatedAt}`
    if (packages.has(key)) return packages.get(key)
    try {
      const value = {
        pkg: city.parsePackage(
          await window.host.run(
            city.PACKAGES,
            workspace,
            city.packageArgs(run.packageDir),
            { text: true },
          ),
        ),
      }
      packages = new Map(packages).set(key, value)
      return value
    } catch (error) {
      return { error: error.message }
    }
  }

  async function followupIndex(workspace, repo, connectors) {
    if (connectors[follow.BEADS] !== 'supported' || connectors[follow.LOCATOR] !== 'supported')
      return { unavailable: 'Connect bd and shell to read city follow-ups.' }
    const key = `${workspace.id}|${repo.toLowerCase()}`
    const cached = followupIndexes.get(key)
    if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.value
    const stores = follow.parseStores(
      await window.host.run(follow.LOCATOR, workspace, follow.locateArgs(), { text: true }),
    )
    const lists = await Promise.all(
      stores.map((dir) => window.host.run(follow.BEADS, workspace, follow.listArgs(dir))),
    )
    const value = { index: follow.indexFollowups(lists.flat(), repo) }
    followupIndexes = new Map(followupIndexes).set(key, { at: Date.now(), value })
    return value
  }

  async function followups(workspace, repo, number, connectors) {
    try {
      const result = await followupIndex(workspace, repo, connectors)
      if (result.unavailable) return { followups: [], unavailable: result.unavailable }
      return { followups: result.index.get(number) ?? [] }
    } catch (error) {
      return { followups: [], error: error.message }
    }
  }

  return Object.freeze({ runs, reviewPackage, followups })
})()
