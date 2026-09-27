import { useEffect, useSyncExternalStore } from 'react'
import type { HostPath } from '../../../shared'
import {
  commitClassificationStore,
  type CommitClassificationState,
} from './commit-classification-store'

export type { CommitClassifications, CommitClassificationState } from './commit-classification-store'

export function useCommitClassifications(
  root: HostPath,
  revisions: readonly string[],
  head?: string,
): CommitClassificationState {
  const store = commitClassificationStore(root)
  const state = useSyncExternalStore(store.subscribe, store.read, store.read)
  useEffect(() => {
    if (head !== undefined) store.invalidate(head)
  }, [store, head])
  const revisionsKey = revisions.join('\n')
  useEffect(() => {
    if (revisionsKey !== '') store.request(revisionsKey.split('\n'))
  }, [store, revisionsKey, state.generation])
  return state
}
