import type {
  IpcEventChannel,
  SessionsProjectionChange,
  SessionsTranscriptChange,
  SessionsUsageChange,
} from '../../shared'
import type { Disposer } from '../project-host/project-host'
import type { SessionsCompanionDemandOwner } from './sessions-demand-owner'

/** The Sessions change channels a companion page can be told about. */
export type SessionsCompanionChannel = Extract<
  IpcEventChannel,
  'sessions:changed' | 'sessions:usage-changed' | 'sessions:transcript-changed'
>

/**
 * Where a companion-kind lease's changes go (ADR-049).
 *
 * One sink per application: the Companion server registers it when it starts
 * and releases it when it stops. Each method receives the exact owner the
 * lease was acquired with, so the sink can fan out by page and generation.
 */
export interface SessionsCompanionSink {
  onProjectionChange(
    owner: SessionsCompanionDemandOwner,
    change: SessionsProjectionChange,
  ): void
  onUsageChange(owner: SessionsCompanionDemandOwner, change: SessionsUsageChange): void
  onTranscriptChange(
    owner: SessionsCompanionDemandOwner,
    change: SessionsTranscriptChange,
  ): void
}

/**
 * Holds the single companion sink and delivers to it. A change with no sink
 * registered is a diagnostic, never a throw: a lease can outlive the server
 * for a moment during shutdown, and the observation source must not fail on
 * that.
 */
export class SessionsCompanionSinkRegistry {
  private sink: SessionsCompanionSink | undefined

  constructor(private readonly onMissing: (channel: SessionsCompanionChannel) => void) {}

  register(sink: SessionsCompanionSink): Disposer {
    if (this.sink !== undefined) {
      throw new Error('Sessions companion sink is already registered')
    }
    this.sink = sink
    return () => {
      if (this.sink === sink) this.sink = undefined
    }
  }

  projection(
    owner: SessionsCompanionDemandOwner,
    change: SessionsProjectionChange,
  ): void {
    const sink = this.current('sessions:changed')
    sink?.onProjectionChange(owner, change)
  }

  usage(owner: SessionsCompanionDemandOwner, change: SessionsUsageChange): void {
    const sink = this.current('sessions:usage-changed')
    sink?.onUsageChange(owner, change)
  }

  transcript(
    owner: SessionsCompanionDemandOwner,
    change: SessionsTranscriptChange,
  ): void {
    const sink = this.current('sessions:transcript-changed')
    sink?.onTranscriptChange(owner, change)
  }

  clear(): void {
    this.sink = undefined
  }

  private current(channel: SessionsCompanionChannel): SessionsCompanionSink | undefined {
    if (this.sink === undefined) this.onMissing(channel)
    return this.sink
  }
}
