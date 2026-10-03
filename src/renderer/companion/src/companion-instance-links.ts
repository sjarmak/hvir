export const COMPANION_INSTANCE_LINKS_KEY = 'hvir.companion.instance-links.v1'
export const COMPANION_INSTANCE_LINK_LIMIT = 20

export function companionInstanceStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export interface CompanionInstanceLink {
  readonly id: string
  readonly name: string
  readonly url: string
}

export type CompanionInstanceLinksRead =
  | { readonly status: 'ok'; readonly links: readonly CompanionInstanceLink[] }
  | { readonly status: 'error'; readonly message: string }

export type CompanionInstanceLinksWrite =
  | { readonly status: 'saved'; readonly links: readonly CompanionInstanceLink[] }
  | { readonly status: 'error'; readonly message: string }

const STORAGE_ERROR =
  'Saved Companion links could not be stored. Check browser storage and try again.'
const CORRUPT_ERROR =
  'Saved Companion links are unreadable. Remove the corrupted entry to recover.'

export function canonicalCompanionEndpoint(input: string): string {
  const url = new URL(input.trim())
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Companion links cannot contain credentials, queries, or fragments')
  }
  const hostname = url.hostname.toLowerCase()
  const loopback =
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use HTTPS, or HTTP on localhost only')
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new Error('Companion links must point to the hvir root')
  }
  url.pathname = '/'
  return url.toString()
}

export function decodeCompanionInstanceLinks(
  raw: string,
): readonly CompanionInstanceLink[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length > COMPANION_INSTANCE_LINK_LIMIT)
    throw new Error(CORRUPT_ERROR)
  const links = parsed.map((value) => decodeLink(value))
  if (new Set(links.map((link) => link.id)).size !== links.length)
    throw new Error(CORRUPT_ERROR)
  return links
}

export function readCompanionInstanceLinks(
  storage: Pick<Storage, 'getItem'>,
): CompanionInstanceLinksRead {
  let raw: string | null
  try {
    raw = storage.getItem(COMPANION_INSTANCE_LINKS_KEY)
  } catch {
    return { status: 'error', message: STORAGE_ERROR }
  }
  if (raw === null) return { status: 'ok', links: [] }
  try {
    return { status: 'ok', links: decodeCompanionInstanceLinks(raw) }
  } catch {
    return { status: 'error', message: CORRUPT_ERROR }
  }
}

export function addCompanionInstanceLink(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  link: CompanionInstanceLink,
  existing?: readonly CompanionInstanceLink[],
): CompanionInstanceLinksWrite {
  const current =
    existing === undefined
      ? readCompanionInstanceLinks(storage)
      : { status: 'ok' as const, links: existing }
  if (current.status === 'error') return current
  if (current.links.length >= COMPANION_INSTANCE_LINK_LIMIT) {
    return {
      status: 'error',
      message: `Save up to ${COMPANION_INSTANCE_LINK_LIMIT} Companion links.`,
    }
  }
  return writeLinks(storage, [...current.links, normalizeLink(link)])
}

export function renameCompanionInstanceLink(
  links: readonly CompanionInstanceLink[],
  id: string,
  name: string,
): readonly CompanionInstanceLink[] {
  const normalized = normalizeName(name)
  return links.map((link) => (link.id === id ? { ...link, name: normalized } : link))
}

export function removeCompanionInstanceLink(
  links: readonly CompanionInstanceLink[],
  id: string,
): readonly CompanionInstanceLink[] {
  return links.filter((link) => link.id !== id)
}

export function writeCompanionInstanceLinks(
  storage: Pick<Storage, 'setItem'>,
  links: readonly CompanionInstanceLink[],
): CompanionInstanceLinksWrite {
  return writeLinks(storage, links)
}

function writeLinks(
  storage: Pick<Storage, 'setItem'>,
  links: readonly CompanionInstanceLink[],
): CompanionInstanceLinksWrite {
  try {
    storage.setItem(
      COMPANION_INSTANCE_LINKS_KEY,
      JSON.stringify(links.map(normalizeLink)),
    )
    return { status: 'saved', links }
  } catch {
    return { status: 'error', message: STORAGE_ERROR }
  }
}

function decodeLink(value: unknown): CompanionInstanceLink {
  if (typeof value !== 'object' || value === null) throw new Error(CORRUPT_ERROR)
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') throw new Error(CORRUPT_ERROR)
  if (typeof record.name !== 'string' || typeof record.url !== 'string')
    throw new Error(CORRUPT_ERROR)
  try {
    return {
      id: record.id,
      name: normalizeName(record.name),
      url: canonicalCompanionEndpoint(record.url),
    }
  } catch {
    throw new Error(CORRUPT_ERROR)
  }
}

function normalizeLink(link: CompanionInstanceLink): CompanionInstanceLink {
  return {
    id: link.id,
    name: normalizeName(link.name),
    url: canonicalCompanionEndpoint(link.url),
  }
}

function normalizeName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > 80)
    throw new Error('Name must be between 1 and 80 characters')
  return trimmed
}
