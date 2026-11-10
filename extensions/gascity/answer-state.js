/* global window */
;(() => {
  const entries = new Map()
  const listeners = new Map()

  const keyOf = (workspaceId, decId, cardSha256) => `${workspaceId}|${decId}|${cardSha256}`
  const IDLE = Object.freeze({ phase: 'idle' })
  const get = (key) => entries.get(key) ?? IDLE

  const phaseOf = (result) => {
    if (result.unknown) return 'unknown'
    if (result.notSent) return 'idle'
    if (result.exitCode === 0) return 'done'
    if (result.exitCode === 1) return 'warning'
    if (result.exitCode === 2) return 'idle'
    return 'unknown'
  }

  const notify = (key) => {
    const live = (listeners.get(key) ?? []).filter((listener) => listener(get(key)))
    if (live.length > 0) listeners.set(key, live)
    else listeners.delete(key)
  }

  const set = (key, entry) => {
    if (entry.phase === 'idle' && entry.result === undefined) entries.delete(key)
    else entries.set(key, entry)
    notify(key)
    return get(key)
  }

  const begin = (key) => {
    if (get(key).phase !== 'idle') return false
    set(key, { phase: 'pending' })
    return true
  }

  const finish = (key, result, at = Date.now()) => set(key, { phase: phaseOf(result), result, at })

  const subscribe = (key, listener) => {
    const current = listeners.get(key) ?? []
    if (!current.includes(listener)) listeners.set(key, [...current, listener])
  }

  const reconcile = (workspaceId, { listedKeys, openKeys, readStartedAt, complete }) => {
    if (!complete) return
    for (const [key, entry] of [...entries]) {
      if (!key.startsWith(`${workspaceId}|`) || entry.phase === 'pending') continue
      const fresh = entry.at < readStartedAt
      if (entry.phase === 'unknown') {
        if (fresh && openKeys.has(key)) set(key, IDLE)
      } else if (fresh && !listedKeys.has(key)) set(key, IDLE)
    }
  }

  window.answerState = Object.freeze({ keyOf, get, begin, finish, subscribe, reconcile })
})()
