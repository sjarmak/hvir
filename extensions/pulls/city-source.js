/* global window */
window.citySource = (() => {
  const city = window.cityReviews
  const INDEX_TTL_MS = 2 * 60 * 1000
  let indexes = new Map()
  let packages = new Map()

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
      return { unavailable: 'Connect the city connector to read review findings.' }
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

  return Object.freeze({ runs, reviewPackage })
})()
