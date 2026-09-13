import { useEffect, useState, type ReactElement } from 'react'

import type { HoneycombLinkConfig } from '../../../shared'
import {
  beadStoreRef,
  beadTraceUrl,
  beadWorkId,
  traceLinkTitle,
  type BeadStore,
} from './analytics-links'

interface BeadTraceLinkProps {
  readonly config: HoneycombLinkConfig
  readonly store: BeadStore
  readonly beadId: string
}

/**
 * A bead's Honeycomb link. The bead id never reaches a span directly; gas-city
 * exports the sha256 of `["work", "<store ref>", "<id>"]` as `gc.work.id`, so
 * the hash is computed here (async, WebCrypto) and the anchor waits for it.
 * The store ref is `rig:<rig>` for a rig-owned bead and `city:<hq rig>` for a
 * city-owned one; the caller names it from the loaded crew, since a hash under
 * the wrong store opens an empty query.
 *
 * A plain anchor is the whole external route: the main window's
 * `setWindowOpenHandler` denies the in-app window and hands https to the OS.
 */
export function BeadTraceLink({
  config,
  store,
  beadId,
}: BeadTraceLinkProps): ReactElement | null {
  const [workId, setWorkId] = useState<string>()
  const storeRef = beadStoreRef(store)

  useEffect(() => {
    let cancelled = false
    setWorkId(undefined)
    beadWorkId(storeRef, beadId)
      .then((hash) => {
        if (!cancelled) setWorkId(hash)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [storeRef, beadId])

  if (workId === undefined) return null
  return (
    <a
      className="beads-trace"
      href={beadTraceUrl(config, store, workId)}
      target="_blank"
      rel="noopener noreferrer"
      title={traceLinkTitle(`bead ${beadId} in ${store.kind} ${store.name}`)}
    >
      trace
    </a>
  )
}
