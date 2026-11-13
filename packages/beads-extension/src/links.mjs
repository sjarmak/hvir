const MAX_URL_LENGTH = 2048

export function beadEvalLink(metadata) {
  if (!metadata || !Object.hasOwn(metadata, 'eval.run_url')) return { kind: 'absent' }
  const url = metadata['eval.run_url']
  const origin = safeHttpsOrigin(url)
  return origin === undefined ? { kind: 'invalid' } : { kind: 'available', url, origin }
}

export function packageAnalyticsUrl(configuration) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration))
    return undefined
  const origin = safeHttpsOrigin(configuration.baseUrl)
  if (origin === undefined || origin !== configuration.baseUrl) return undefined
  const dashboardId = configuration.dashboardId
  if (typeof dashboardId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/u.test(dashboardId))
    return undefined
  return `${origin}/dashboards/${encodeURIComponent(dashboardId)}`
}

function safeHttpsOrigin(raw) {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > MAX_URL_LENGTH ||
    raw.trim() !== raw ||
    hasUnsafeText(raw) ||
    raw.includes('\\')
  )
    return undefined
  try {
    if (hasUnsafeText(decodeURIComponent(raw))) return undefined
    const url = new globalThis.URL(raw)
    if (
      url.protocol !== 'https:' ||
      !raw.startsWith('https://') ||
      url.username ||
      url.password ||
      !url.hostname
    )
      return undefined
    return url.origin
  } catch {
    return undefined
  }
}

function hasUnsafeText(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    )
  })
}
