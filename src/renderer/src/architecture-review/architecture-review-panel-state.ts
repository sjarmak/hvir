import type { HostPath } from '../../../shared'

export interface ArchitectureReviewPanelState {
  readonly explanationCollapsed: boolean
}

const DEFAULT_ARCHITECTURE_REVIEW_PANEL_STATE: ArchitectureReviewPanelState = {
  explanationCollapsed: false,
}

export class ArchitectureReviewPanelStateSession {
  readonly #states = new Map<string, ArchitectureReviewPanelState>()

  read(root: HostPath): ArchitectureReviewPanelState {
    return this.#states.get(projectKey(root)) ?? DEFAULT_ARCHITECTURE_REVIEW_PANEL_STATE
  }

  write(root: HostPath, state: ArchitectureReviewPanelState): void {
    this.#states.set(projectKey(root), state)
  }
}

function projectKey(root: HostPath): string {
  return JSON.stringify([root.hostId, root.path])
}
