import type {
  ArchitectureCommitChange,
  FleetCommitClassification,
} from '../../../shared/architecture-review'
import { fleetChangeTitle } from './fleet-classification-label'

export interface ChangeMarker {
  readonly kind: ArchitectureCommitChange | 'merge'
  readonly label: string
  readonly title?: string
}

const CHANGE_LABELS: Record<ArchitectureCommitChange, string | undefined> = {
  architecture: 'Architecture',
  code: 'Code',
  unclassified: 'Unclassified',
  none: undefined,
}

export function changeMarker(
  merge: boolean,
  change: ArchitectureCommitChange | undefined,
  fleet: FleetCommitClassification | undefined,
): ChangeMarker | undefined {
  const kind = merge ? 'merge' : change
  if (kind === undefined) return undefined
  const label = fleet?.type ?? (kind === 'merge' ? 'Merge' : CHANGE_LABELS[kind])
  if (label === undefined) return undefined
  return {
    kind,
    label,
    ...(fleet === undefined ? {} : { title: fleetChangeTitle(fleet) }),
  }
}
