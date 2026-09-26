import {
  ARCHITECTURE_EXPLANATION_FILE,
  ARCHITECTURE_EXPLANATION_MAX_BYTES,
  ArchitectureExplanationError,
  checkArchitectureExplanation,
  parseArchitectureExplanation,
  type ArchitectureExplanationState,
} from '../../shared/architecture-explanation'
import type { ArchitectureReviewSnapshot } from '../../shared/architecture-review'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'

const SETTLE_MS = 250
const MAX_EXPLANATIONS = 16

interface ExplanationWatcher {
  readonly scope: string
  readonly host: ProjectHost
  readonly file: HostPath
  readonly snapshot: ArchitectureReviewSnapshot
  readonly publish: (state: ArchitectureExplanationState) => void
  readonly stop: () => void | Promise<void>
  readonly generation: number
  readonly timer?: ReturnType<typeof setTimeout>
}

export class ArchitectureExplanationStore {
  private readonly states = new Map<
    string,
    { readonly scope: string; readonly state: ArchitectureExplanationState }
  >()
  private readonly watchers = new Map<string, ExplanationWatcher>()

  get(scope: string, snapshotId: string): ArchitectureExplanationState | null {
    const stored = this.states.get(snapshotId)
    return stored?.scope === scope ? stored.state : null
  }

  watch(
    scope: string,
    host: ProjectHost,
    worktree: HostPath,
    snapshot: ArchitectureReviewSnapshot,
    publish: (state: ArchitectureExplanationState) => void,
  ): void {
    this.stop(snapshot.id)
    const waiting: ArchitectureExplanationState = {
      status: 'waiting',
      snapshotId: snapshot.id,
    }
    this.store(scope, snapshot.id, waiting)
    publish(waiting)
    const watcher: ExplanationWatcher = {
      scope,
      host,
      file: joinHostPath(worktree, ARCHITECTURE_EXPLANATION_FILE),
      snapshot,
      publish,
      generation: 0,
      stop: host.watch(worktree, () => this.schedule(snapshot.id), {
        recursive: false,
        onError: (error) => this.publishInvalid(snapshot.id, String(error)),
      }),
    }
    this.watchers.set(snapshot.id, watcher)
    this.schedule(snapshot.id)
  }

  clear(): void {
    for (const snapshotId of this.watchers.keys()) this.stop(snapshotId)
    this.states.clear()
  }

  clearScope(scope: string): void {
    for (const [snapshotId, watcher] of this.watchers)
      if (watcher.scope === scope) this.stop(snapshotId)
    for (const [snapshotId, stored] of this.states)
      if (stored.scope === scope) this.states.delete(snapshotId)
  }

  private schedule(snapshotId: string): void {
    const watcher = this.watchers.get(snapshotId)
    if (!watcher) return
    if (watcher.timer) clearTimeout(watcher.timer)
    const generation = watcher.generation + 1
    const timer = setTimeout(() => {
      const current = this.watchers.get(snapshotId)
      if (!current || current.generation !== generation) return
      this.watchers.set(snapshotId, { ...current, timer: undefined })
      void this.read(snapshotId, generation)
    }, SETTLE_MS)
    this.watchers.set(snapshotId, { ...watcher, generation, timer })
  }

  private async read(snapshotId: string, generation: number): Promise<void> {
    const watcher = this.watchers.get(snapshotId)
    if (!watcher || watcher.generation !== generation) return
    try {
      const prefix = await watcher.host.readTextFilePrefix(
        watcher.file,
        ARCHITECTURE_EXPLANATION_MAX_BYTES + 1,
      )
      const current = this.watchers.get(snapshotId)
      if (!current || current.generation !== generation) return
      if (!prefix.complete)
        throw new ArchitectureExplanationError('Explanation is larger than 64 KiB')
      if (prefix.validUtf8 === false)
        throw new ArchitectureExplanationError('Explanation is not valid UTF-8')
      const explanation = checkArchitectureExplanation(
        parseArchitectureExplanation(prefix.content),
        current.snapshot,
      )
      const ready: ArchitectureExplanationState = { status: 'ready', explanation }
      this.store(current.scope, snapshotId, ready)
      current.publish(ready)
      this.stop(snapshotId)
    } catch (error) {
      if (isMissingFile(error)) return
      this.publishInvalid(
        snapshotId,
        error instanceof Error ? error.message : String(error),
        generation,
      )
    }
  }

  private publishInvalid(snapshotId: string, message: string, generation?: number): void {
    const watcher = this.watchers.get(snapshotId)
    if (!watcher || (generation !== undefined && watcher.generation !== generation)) return
    const invalid: ArchitectureExplanationState = {
      status: 'invalid',
      snapshotId,
      message,
    }
    this.store(watcher.scope, snapshotId, invalid)
    watcher.publish(invalid)
  }

  private store(
    scope: string,
    snapshotId: string,
    state: ArchitectureExplanationState,
  ): void {
    this.states.delete(snapshotId)
    this.states.set(snapshotId, { scope, state })
    while (this.states.size > MAX_EXPLANATIONS) {
      const oldest = this.states.keys().next().value!
      this.stop(oldest)
      this.states.delete(oldest)
    }
  }

  private stop(snapshotId: string): void {
    const watcher = this.watchers.get(snapshotId)
    if (!watcher) return
    this.watchers.delete(snapshotId)
    if (watcher.timer) clearTimeout(watcher.timer)
    void Promise.resolve(watcher.stop()).catch((error: unknown) => {
      console.error('[architecture-review] explanation watch cleanup failed', error)
    })
  }
}

function isMissingFile(error: unknown): boolean {
  const code =
    error && typeof error === 'object'
      ? (error as { readonly code?: unknown }).code
      : undefined
  return code === 'ENOENT' || code === 2
}
