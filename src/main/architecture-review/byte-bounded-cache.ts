interface Entry<V> {
  readonly value: V
  readonly bytes: number
}

export class ByteBoundedCache<V> {
  private readonly entries = new Map<string, Entry<V>>()
  private total = 0

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error('Byte-bounded cache needs a positive byte bound')
  }

  get size(): number {
    return this.entries.size
  }

  get bytes(): number {
    return this.total
  }

  lookup(key: string): V | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  store(key: string, value: V, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error('Byte-bounded cache entries need a non-negative byte count')
    this.remove(key)
    if (bytes > this.maxBytes) return
    this.entries.set(key, { value, bytes })
    this.total += bytes
    while (this.total > this.maxBytes) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.remove(oldest)
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    this.total -= entry.bytes
  }
}
