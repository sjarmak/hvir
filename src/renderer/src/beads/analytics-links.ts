import {
  SAFE_COMPONENT,
  type GasCitySession,
  type HoneycombLinkConfig,
  type OmniLinkConfig,
} from '../../../shared'

/**
 * Pure URL construction for the observability links on crew and bead cards.
 * No React, no window: every function here is a string in, string out, so the
 * tests can pin the exact filters a link carries. No credential ever enters a
 * URL; the links open the vendor UI, which authenticates on its own.
 *
 * The identity facts encoded here were verified against gas-city's exporter,
 * not the brief: `gen_ai.agent.name` is `<rig>.<agent>` with the agent being the
 * safe-component basename of GC_AGENT (bin/lib/gc-seat-tracing.sh), and a bead
 * appears only as `gc.work.id`, the sha256 of the compact, ensure_ascii JSON
 * `["work", "<store_ref>", "<bead id>"]` (bin/honeycomb_lifecycle.py).
 */

/** Two hours: the query window every trace link opens, counted from the click. */
export const TRACE_LOOKBACK_SECONDS = 7200

export interface HoneycombFilter {
  readonly column: string
  readonly op: '='
  readonly value: string
}

const enc = encodeURIComponent

export function honeycombQueryUrl(
  cfg: HoneycombLinkConfig,
  filters: readonly HoneycombFilter[],
  timeRangeSeconds = TRACE_LOOKBACK_SECONDS,
): string {
  const query = JSON.stringify({
    calculations: [{ op: 'COUNT' }],
    filters,
    filter_combination: 'AND',
    breakdowns: ['gen_ai.operation.name'],
    time_range: timeRangeSeconds,
  })
  return (
    `https://ui.honeycomb.io/${enc(cfg.team)}/environments/${enc(cfg.environment)}` +
    `/datasets/${enc(cfg.dataset)}/?query=${enc(query)}`
  )
}

/**
 * The `gen_ai.agent.name` gas-city would have exported for this member, or
 * undefined when either half fails the safe-component rule; a link that could
 * never match is worse than no link.
 */
export function agentName(
  rig: string,
  session: Pick<GasCitySession, 'template' | 'name'>,
): string | undefined {
  const source = session.template ?? session.name
  const agent = source.slice(source.lastIndexOf('/') + 1)
  if (!SAFE_COMPONENT.test(rig) || !SAFE_COMPONENT.test(agent)) return undefined
  return `${rig}.${agent}`
}

export function sessionTraceUrl(
  cfg: HoneycombLinkConfig,
  rig: string,
  session: Pick<GasCitySession, 'template' | 'name'>,
): string | undefined {
  const agent = agentName(rig, session)
  if (agent === undefined) return undefined
  return honeycombQueryUrl(cfg, [
    { column: 'gen_ai.agent.name', op: '=', value: agent },
    { column: 'gc.rig', op: '=', value: rig },
  ])
}

export function beadTraceUrl(cfg: HoneycombLinkConfig, rig: string, workId: string): string {
  return honeycombQueryUrl(cfg, [
    { column: 'gc.work.id', op: '=', value: workId },
    { column: 'gc.rig', op: '=', value: rig },
  ])
}

/** Python `json.dumps(..., ensure_ascii=True)`: every code unit above 0x7e as `\uXXXX`. */
export function escapeNonAscii(json: string): string {
  let out = ''
  for (let index = 0; index < json.length; index += 1) {
    const unit = json.charCodeAt(index)
    out += unit > 0x7e ? `\\u${unit.toString(16).padStart(4, '0')}` : json[index]
  }
  return out
}

/** The exact bytes gas-city hashes for a bead's work id. */
export function workIdInput(storeRef: string, beadId: string): string {
  return escapeNonAscii(JSON.stringify(['work', storeRef, beadId]))
}

export async function beadWorkId(storeRef: string, beadId: string): Promise<string> {
  const bytes = new TextEncoder().encode(workIdInput(storeRef, beadId))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

/**
 * The Omni model home, or its dashboard when one is configured, filtered on the
 * rig through Omni's `f--<filter id>` dashboard parameter when that id is known.
 */
export function omniAnalyticsUrl(cfg: OmniLinkConfig, rig?: string): string {
  const page =
    cfg.dashboardId === undefined ? cfg.baseUrl : `${cfg.baseUrl}/dashboards/${enc(cfg.dashboardId)}`
  if (cfg.rigFilterId === undefined || rig === undefined) return page
  return `${page}?f--${cfg.rigFilterId}=${enc(JSON.stringify({ values: [rig] }))}`
}

/** Every link names its window, so the reader knows the query is not a snapshot. */
export function traceLinkTitle(subject: string): string {
  return `Honeycomb: spans for ${subject}, last 2h from when opened`
}
