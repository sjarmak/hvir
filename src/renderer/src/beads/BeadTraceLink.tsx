import { useEffect, useState, type ReactElement } from 'react'

import type { HoneycombLinkConfig } from '../../../shared'
import { beadTraceUrl, beadWorkId, traceLinkTitle } from './analytics-links'

interface BeadTraceLinkProps {
  readonly config: HoneycombLinkConfig
  readonly rig: string
  readonly beadId: string
}

/**
 * A bead's Honeycomb link. The bead id never reaches a span directly; gas-city
 * exports the sha256 of `["work", "rig:<rig>", "<id>"]` as `gc.work.id`, so the
 * hash is computed here (async, WebCrypto) and the anchor waits for it. The
 * store is assumed to be the rig's: a bead owned by the city hashes under
 * `city:<name>`, which the rig workspace does not know, and opens empty.
 *
 * A plain anchor is the whole external route: the main window's
 * `setWindowOpenHandler` denies the in-app window and hands https to the OS.
 */
export function BeadTraceLink({ config, rig, beadId }: BeadTraceLinkProps): ReactElement | null {
  const [workId, setWorkId] = useState<string>()

  useEffect(() => {
    let cancelled = false
    setWorkId(undefined)
    beadWorkId(`rig:${rig}`, beadId)
      .then((hash) => {
        if (!cancelled) setWorkId(hash)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [rig, beadId])

  if (workId === undefined) return null
  return (
    <a
      className="beads-trace"
      href={beadTraceUrl(config, rig, workId)}
      target="_blank"
      rel="noopener noreferrer"
      title={traceLinkTitle(`bead ${beadId} in ${rig}`)}
    >
      trace
    </a>
  )
}
