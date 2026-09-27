import type { FleetCommitClassification } from '../../../shared/architecture-review'

const ARCHITECTURAL = 'architectural'
const NONE = 'none'

export function fleetChangeSummary(fleet: FleetCommitClassification): string {
  return [
    fleet.type,
    significance(fleet.architectural),
    capitalized(fleet.scope),
    capitalized(fleet.compatibility),
    risk(fleet.risk),
  ]
    .filter((part) => part !== undefined)
    .join(' · ')
}

export function fleetChangeTitle(fleet: FleetCommitClassification): string {
  return [
    fleetChangeSummary(fleet),
    ...(fleet.behavior === undefined ? [] : [`Behavior: ${fleet.behavior}`]),
    ...(fleet.beads.length === 0 ? [] : [`Bead: ${fleet.beads.join(', ')}`]),
    ...(fleet.classifiedBy === undefined ? [] : [`Classified by: ${fleet.classifiedBy}`]),
  ].join('\n')
}

function significance(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const level = value.toLowerCase()
  if (level === ARCHITECTURAL) return 'Architectural'
  if (level === NONE) return 'Non-architectural'
  return capitalized(value)
}

function risk(value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${capitalized(value)} risk`
}

function capitalized(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.charAt(0).toUpperCase() + value.slice(1)
}
