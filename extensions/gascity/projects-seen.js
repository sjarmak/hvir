;(() => {
  const KEY = 'gascity.projects.lastLooked'

  const visit = (getStorage, now) => {
    try {
      const storage = getStorage()
      const previous = storage.getItem(KEY)
      storage.setItem(KEY, now)
      return previous || null
    } catch {
      return null
    }
  }

  const api = Object.freeze({ visit })
  if (typeof module === 'object') module.exports = api
  else window.projectsSeen = api
})()
