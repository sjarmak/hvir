import type { NeedsYouChangedEvent, NeedsYouSnapshot } from '../../../shared'

export interface NeedsYouReadPort {
  observe(generation: number): Promise<NeedsYouSnapshot>
  refresh(generation: number): Promise<NeedsYouSnapshot>
  release(generation: number): Promise<void>
  subscribe?(listener: (event?: NeedsYouChangedEvent) => void): () => void
}

export type NeedsYouReadState =
  | { readonly status: 'inactive' | 'pending' }
  | { readonly status: 'unavailable'; readonly message: string }
  | { readonly status: 'available'; readonly snapshot: NeedsYouSnapshot }

let nextDemandGeneration = 0

export class NeedsYouCoordinator {
  private current: NeedsYouReadState = { status: 'inactive' }
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private consumers = 0
  private established = false
  private unsubscribe?: () => void
  private invalidatedAt: number | undefined

  constructor(
    private readonly port: NeedsYouReadPort,
    private readonly report: (message: string) => void,
  ) {}

  snapshot = (): NeedsYouReadState => this.current

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  acquire(): () => void {
    this.consumers += 1
    if (this.consumers === 1) {
      this.generation = ++nextDemandGeneration
      this.established = false
      this.unsubscribe = this.port.subscribe?.((event) => {
        this.invalidatedAt = event?.candidateRevision ?? Number.POSITIVE_INFINITY
        if (this.current.status !== 'pending') this.publishInvalidated()
      })
      void this.read(true)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      this.consumers -= 1
      if (this.consumers > 0) return
      const generation = this.generation
      this.generation = 0
      this.unsubscribe?.()
      this.unsubscribe = undefined
      this.publish({ status: 'inactive' })
      void this.port.release(generation).catch((error: unknown) => {
        this.report(error instanceof Error ? error.message : String(error))
      })
    }
  }

  refresh = (): void => {
    if (this.consumers === 0 || this.current.status === 'pending') return
    void this.read(!this.established)
  }

  private async read(initial: boolean): Promise<void> {
    const generation = this.generation
    this.invalidatedAt = undefined
    this.publish({ status: 'pending' })
    try {
      const snapshot = await (initial
        ? this.port.observe(generation)
        : this.port.refresh(generation))
      if (this.generation !== generation) return
      if (snapshot.version !== 1 || snapshot.demandGeneration !== generation) {
        throw new Error('Needs you received an obsolete observation. Refresh to retry.')
      }
      this.established = true
      if (
        this.invalidatedAt !== undefined &&
        (snapshot.candidateRevision ?? Number.NEGATIVE_INFINITY) < this.invalidatedAt
      ) {
        this.publishInvalidated()
        return
      }
      this.publish({ status: 'available', snapshot })
    } catch (error) {
      if (this.generation !== generation) return
      this.publish({
        status: 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private publishInvalidated(): void {
    this.publish({
      status: 'unavailable',
      message: 'Workspace availability changed. Refresh to read current sources.',
    })
  }

  private publish(state: NeedsYouReadState): void {
    this.current = state
    for (const listener of this.listeners) listener()
  }
}
