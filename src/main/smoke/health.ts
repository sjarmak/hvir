import type { WorkbenchHealthSnapshot } from '../../shared'

export function memoryOnlyHealth(): WorkbenchHealthSnapshot {
  return { version: 1, evidence: 'memory-only', items: [], dropped: 0 }
}
