/** Retained PTY output budget shared by the renderer replay and the mirror tail. */
export const PTY_OUTPUT_TAIL_CHARS = 256 * 1024

/**
 * The newest `PTY_OUTPUT_TAIL_CHARS` characters of a stream, kept as ordered chunks.
 *
 * Fed on every PTY read for the session's whole life, so `retain` is amortised O(1):
 * chunks are appended in place, consumed chunks advance a head index, and the array
 * is compacted only once at least half of it is dead.
 */
export class PtyOutputTail {
  private chunks: string[] = []
  private head = 0
  private length = 0

  retain(data: string): void {
    if (data.length >= PTY_OUTPUT_TAIL_CHARS) {
      this.chunks = [data.slice(-PTY_OUTPUT_TAIL_CHARS)]
      this.head = 0
      this.length = PTY_OUTPUT_TAIL_CHARS
      return
    }
    this.chunks.push(data)
    this.length += data.length
    this.dropOverflow()
  }

  text(): string {
    return this.chunks.slice(this.head).join('')
  }

  /** The chunks in arrival order; the tail is empty afterwards. */
  drain(): string[] {
    const drained = this.chunks.slice(this.head)
    this.clear()
    return drained
  }

  clear(): void {
    this.chunks = []
    this.head = 0
    this.length = 0
  }

  private dropOverflow(): void {
    while (this.length > PTY_OUTPUT_TAIL_CHARS && this.head < this.chunks.length) {
      const overflow = this.length - PTY_OUTPUT_TAIL_CHARS
      const first = this.chunks[this.head] ?? ''
      if (first.length <= overflow) {
        this.head += 1
        this.length -= first.length
      } else {
        this.chunks[this.head] = first.slice(overflow)
        this.length -= overflow
      }
    }
    if (this.head > 0 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }
}
