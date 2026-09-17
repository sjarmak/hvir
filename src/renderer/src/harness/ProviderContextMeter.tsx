import type { ReactElement } from 'react'

import type { HarnessContextPressurePolicy, SessionsContextFact } from '../../../shared'

export type ProviderContextFacet =
  | { readonly status: 'unsupported' }
  | { readonly status: 'pending' | 'unavailable'; readonly reason?: string }
  | {
      readonly status: 'available' | 'stale'
      readonly value: SessionsContextFact
      readonly reason?: string
    }

export function ProviderContextMeter({
  contextFacet,
  countOnly = false,
  pressurePolicy,
}: {
  readonly contextFacet?: ProviderContextFacet
  readonly countOnly?: boolean
  readonly pressurePolicy?: HarnessContextPressurePolicy
}): ReactElement {
  const context =
    contextFacet?.status === 'available' || contextFacet?.status === 'stale'
      ? contextFacet.value
      : undefined
  const contextStatus = contextFacet?.status
  const usedTokens = context?.usedTokens
  const assumedWindowTokens =
    context?.windowTokens === undefined ? pressurePolicy?.assumedWindowTokens : undefined
  const presentationWindowTokens = context?.windowTokens ?? assumedWindowTokens
  const reportedPercent = countOnly
    ? undefined
    : (context?.usedPercent ??
      (usedTokens !== undefined && presentationWindowTokens
        ? (usedTokens / presentationWindowTokens) * 100
        : undefined))
  const percent =
    typeof reportedPercent === 'number' && Number.isFinite(reportedPercent)
      ? Math.min(100, Math.max(0, reportedPercent))
      : undefined
  const displayPercent = percent === undefined ? undefined : Math.floor(percent)
  const hasCountOnly = usedTokens !== undefined && displayPercent === undefined
  const pressure = hasCountOnly
    ? 'count-only'
    : contextStatus === 'pending'
      ? 'pending'
      : contextStatus === 'unavailable'
        ? 'unavailable'
        : displayPercent === undefined
          ? 'unknown'
          : displayPercent >= (pressurePolicy?.criticalPercent ?? 70)
            ? 'critical'
            : displayPercent >= (pressurePolicy?.warningPercent ?? 40)
              ? 'warning'
              : 'normal'
  const label =
    contextStatus === 'pending'
      ? (contextFacet?.reason ?? 'Waiting for context telemetry')
      : contextStatus === 'unavailable'
        ? (contextFacet?.reason ?? 'Context telemetry unavailable')
        : usedLabel({
            usedTokens,
            windowTokens: context?.windowTokens,
            assumedWindowTokens,
            displayPercent,
          })

  return (
    <span
      className={`provider-context ${pressure}${countOnly ? ' count-display' : ''}`}
      title={label}
      aria-label={context === undefined ? label : undefined}
    >
      {!countOnly ? (
        displayPercent === undefined ? (
          <span className="provider-context-track" aria-hidden="true" />
        ) : (
          <span
            className="provider-context-track"
            role="progressbar"
            aria-label="Context used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={displayPercent}
            aria-valuetext={label}
          >
            <span className="provider-context-fill" style={{ width: `${percent}%` }} />
          </span>
        )
      ) : null}
      <span className="provider-context-value">
        {contextStatus === 'pending'
          ? '…'
          : contextStatus === 'unavailable'
            ? '!'
            : hasCountOnly
              ? formatTokenCount(usedTokens)
              : displayPercent === undefined
                ? '--'
                : `${displayPercent}%`}
      </span>
    </span>
  )
}

/**
 * What the meter claims to know. A source may report a token count, a window,
 * both, or only a percentage, and each combination has its own honest sentence:
 * saying "0 tokens" for a source that never counts them would be worse than
 * saying nothing.
 */
function usedLabel({
  usedTokens,
  windowTokens,
  assumedWindowTokens,
  displayPercent,
}: {
  readonly usedTokens?: number
  readonly windowTokens?: number
  readonly assumedWindowTokens?: number
  readonly displayPercent?: number
}): string {
  if (usedTokens === undefined) {
    return displayPercent === undefined
      ? 'Context usage unavailable'
      : `${displayPercent}% of context used`
  }
  if (windowTokens !== undefined) {
    return `${formatTokenCount(usedTokens)} / ${formatTokenCount(windowTokens)} context used`
  }
  if (assumedWindowTokens !== undefined) {
    return `${formatTokenCount(usedTokens)} / ${formatTokenCount(assumedWindowTokens)} context used (assumed capacity)`
  }
  return `${formatTokenCount(usedTokens)} current context tokens; limit unavailable`
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${trimFraction(value / 1_000_000)}m`
  if (value >= 1_000) return `${trimFraction(value / 1_000)}k`
  return String(Math.round(value))
}

function trimFraction(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
}
