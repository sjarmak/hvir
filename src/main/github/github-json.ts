export type JsonRecord = Readonly<Record<string, unknown>>

export function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function nodesOf(connection: unknown): readonly JsonRecord[] {
  const nodes = asRecord(connection)?.['nodes']
  if (!Array.isArray(nodes)) return []
  return nodes.flatMap((node) => {
    const record = asRecord(node)
    return record === undefined ? [] : [record]
  })
}

export interface Actor {
  readonly login?: string
  readonly bot: boolean
}

export function actor(value: unknown): Actor {
  const record = asRecord(value)
  const login = asString(record?.['login'])
  return {
    ...(login === undefined ? {} : { login }),
    bot: record?.['__typename'] === 'Bot',
  }
}

/**
 * The later of two ISO timestamps. An unparseable candidate never replaces `current`, and
 * a parseable candidate always replaces an unparseable `current`.
 */
export function laterIso(current: string | undefined, candidate: string): string {
  if (current === undefined) return candidate
  const next = Date.parse(candidate)
  if (Number.isNaN(next)) return current
  const held = Date.parse(current)
  return Number.isNaN(held) || next > held ? candidate : current
}
