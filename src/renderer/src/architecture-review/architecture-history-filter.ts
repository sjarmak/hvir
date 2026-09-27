import { useSyncExternalStore } from 'react'
import type { ArchitectureCommitChange } from '../../../shared/architecture-review'

export const ARCHITECTURE_FILTER_STORAGE_KEY = 'hvir:architecture-changes-only'
const listeners = new Set<() => void>()
let active = readStored()

export function readArchitectureFilter(): boolean {
  return active
}

export function setArchitectureFilter(on: boolean): void {
  if (on === active) return
  active = on
  try {
    localStorage.setItem(ARCHITECTURE_FILTER_STORAGE_KEY, String(on))
  } catch {
    active = on
  }
  for (const listener of listeners) listener()
}

export function useArchitectureFilter(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => active,
    () => active,
  )
}

export function commitShownUnderFilter(
  filterOn: boolean,
  merge: boolean,
  change: ArchitectureCommitChange | undefined,
): boolean {
  if (!filterOn) return true
  if (merge) return false
  return change === 'architecture' || change === 'unclassified'
}

function readStored(): boolean {
  try {
    return localStorage.getItem(ARCHITECTURE_FILTER_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}
