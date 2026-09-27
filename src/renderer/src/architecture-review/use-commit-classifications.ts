import { useEffect, useRef, useState } from 'react'
import type { HostPath } from '../../../shared'
import {
  ARCHITECTURE_CLASSIFY_LIMIT,
  type ArchitectureCommitChange,
} from '../../../shared/architecture-review'

export type CommitClassifications = ReadonlyMap<string, ArchitectureCommitChange>

interface ClassificationQueue {
  readonly known: Map<string, ArchitectureCommitChange>
  readonly requested: Set<string>
  readonly queue: string[]
  draining: boolean
  disposed: boolean
}

function emptyQueue(): ClassificationQueue {
  return {
    known: new Map(),
    requested: new Set(),
    queue: [],
    draining: false,
    disposed: false,
  }
}

export function useCommitClassifications(
  root: HostPath,
  revisions: readonly string[],
): CommitClassifications {
  const rootKey = `${root.hostId}\0${root.path}`
  const state = useRef<ClassificationQueue>(emptyQueue())
  const [published, setPublished] = useState<CommitClassifications>(new Map())
  const revisionsKey = revisions.join('\n')
  useEffect(() => {
    const queue = emptyQueue()
    state.current = queue
    setPublished(new Map())
    return () => {
      queue.disposed = true
    }
  }, [rootKey])
  useEffect(() => {
    const queue = state.current
    for (const revision of revisionsKey === '' ? [] : revisionsKey.split('\n')) {
      if (!queue.requested.has(revision)) {
        queue.requested.add(revision)
        queue.queue.push(revision)
      }
    }
    if (!queue.draining) void drain(root, queue, setPublished)
  }, [root, revisionsKey])
  return published
}

async function drain(
  root: HostPath,
  queue: ClassificationQueue,
  publish: (next: CommitClassifications) => void,
): Promise<void> {
  queue.draining = true
  try {
    while (queue.queue.length > 0 && !queue.disposed) {
      const batch = queue.queue.splice(0, ARCHITECTURE_CLASSIFY_LIMIT)
      try {
        const answers = await window.hvir.invoke('architecture-review:classify-commits', {
          root,
          revisions: batch,
        })
        if (queue.disposed) return
        for (const answer of answers) queue.known.set(answer.revision, answer.change)
        publish(new Map(queue.known))
      } catch {
        for (const revision of batch) queue.requested.delete(revision)
        return
      }
    }
  } finally {
    queue.draining = false
  }
}
