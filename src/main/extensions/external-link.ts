import { extensionObject } from '../../shared/extensions/manifest'

export const EXTERNAL_LINK_LIMITS = {
  urlChars: 2048,
  intervalMs: 1000,
} as const

const EXTERNAL_LINK_HOSTS: ReadonlySet<string> = new Set(['github.com'])

export function extensionExternalUrl(input: unknown): string {
  const raw = extensionObject(input)['url']
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > EXTERNAL_LINK_LIMITS.urlChars
  )
    throw new Error(
      `External link url must be 1-${EXTERNAL_LINK_LIMITS.urlChars} characters`,
    )
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('External link url is not a URL')
  }
  if (
    url.protocol !== 'https:' ||
    !EXTERNAL_LINK_HOSTS.has(url.hostname) ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  )
    throw new Error('External links open only https://github.com addresses')
  return url.href
}

export class ExtensionExternalLinks {
  private readonly lastOpened = new Map<string, number>()

  constructor(
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  async open(installationId: string, input: unknown): Promise<void> {
    const url = extensionExternalUrl(input)
    const at = this.now()
    const previous = this.lastOpened.get(installationId)
    if (previous !== undefined && at - previous < EXTERNAL_LINK_LIMITS.intervalMs)
      throw new Error('External links open at most once per second')
    this.lastOpened.set(installationId, at)
    await this.openExternal(url)
  }
}
