import type { WebFrameMain } from 'electron'

import type { IpcEventChannel, IpcEventPayload } from '../shared'

const DISPOSED_RENDER_FRAME_MESSAGE =
  'Render frame was disposed before WebFrameMain could be accessed'

export type RendererEventDeliveryFailure = 'disposed-frame'
export type RendererEventDeliveryTarget = 'available' | 'disposed-frame'

interface RendererEventTarget {
  readonly mainFrame: Pick<WebFrameMain, 'isDestroyed' | 'postMessage'>
}

/** Deliver one typed event while treating only Electron's disposed-frame race as stale. */
export function sendRendererEvent<E extends IpcEventChannel>(
  target: RendererEventTarget,
  channel: E,
  payload: IpcEventPayload<E>,
): void {
  sendRendererMessage(target, channel, payload)
}

export function sendRendererMessage(
  target: RendererEventTarget,
  channel: string,
  payload: unknown,
): void {
  try {
    const frame = target.mainFrame
    if (classifyRendererEventDeliveryTarget(frame.isDestroyed()) === 'disposed-frame') {
      return
    }
    frame.postMessage(channel, payload)
  } catch (error) {
    classifyRendererEventDeliveryFailure(error)
  }
}

/** Pure target-state policy applied before entering Electron's frame delivery edge. */
export function classifyRendererEventDeliveryTarget(
  destroyed: boolean,
): RendererEventDeliveryTarget {
  return destroyed ? 'disposed-frame' : 'available'
}

/** Pure classification for the one Electron delivery failure that means the target is gone. */
export function classifyRendererEventDeliveryFailure(
  error: unknown,
): RendererEventDeliveryFailure {
  if (error instanceof Error && error.message === DISPOSED_RENDER_FRAME_MESSAGE) {
    return 'disposed-frame'
  }
  throw error
}
