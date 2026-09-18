/**
 * The page's arming state as a hook (ADR-050): armed by the person for one
 * mirror, disarmed when the page is hidden or unloaded, when that mirror is
 * left or ends, or when the idle bound lapses. An arming is bound to the
 * mirror it was made for, so the next mirror always opens disarmed. A page
 * that returns to view re-evaluates at once, so an arming whose bound passed
 * while hidden never types.
 */
import { useCallback, useEffect, useState } from 'react'

import type { SessionsTerminalHandle } from '../../../shared'
import {
  armInput,
  disarmInput,
  inputArmingAfterTick,
  touchInput,
  type CompanionInputArming,
} from './companion-input-arming'

const TICK_MS = 1_000

export interface CompanionInputArmingControl {
  readonly armed: boolean
  readonly arm: () => void
  readonly disarm: () => void
  /** A key was sent; the idle bound starts over. */
  readonly touch: () => void
}

interface MirrorArming {
  readonly arming: CompanionInputArming
  /** The mirror the arming was made for; any other mirror reads as disarmed. */
  readonly mirror?: SessionsTerminalHandle
}

const DISARMED: MirrorArming = { arming: disarmInput() }

function withArming(current: MirrorArming, arming: CompanionInputArming): MirrorArming {
  return arming === current.arming ? current : { ...current, arming }
}

/** `mirror` names the live mirror on the page, or nothing while there is none. */
export function useInputArming(
  mirror: SessionsTerminalHandle | undefined,
): CompanionInputArmingControl {
  const [state, setState] = useState<MirrorArming>(DISARMED)
  const armed = state.arming.armed && mirror !== undefined && state.mirror === mirror

  useEffect(() => {
    const onVisibility = (): void => {
      setState((current) =>
        document.hidden
          ? DISARMED
          : withArming(current, inputArmingAfterTick(current.arming, Date.now())),
      )
    }
    const onHide = (): void => setState(DISARMED)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onHide)
    }
  }, [])

  useEffect(() => {
    setState((current) => (current.mirror === mirror ? current : DISARMED))
  }, [mirror])

  useEffect(() => {
    if (!armed) return
    const timer = setInterval(
      () =>
        setState((current) =>
          withArming(current, inputArmingAfterTick(current.arming, Date.now())),
        ),
      TICK_MS,
    )
    return () => clearInterval(timer)
  }, [armed])

  const arm = useCallback(() => {
    if (mirror !== undefined) setState({ arming: armInput(Date.now()), mirror })
  }, [mirror])
  const disarm = useCallback(() => setState(DISARMED), [])
  const touch = useCallback(
    () =>
      setState((current) => withArming(current, touchInput(current.arming, Date.now()))),
    [],
  )

  return { armed, arm, disarm, touch }
}
