import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererEventPublisher } from '../renderer-event-publisher'
import type { WorkbenchRuntime } from '../workbench-runtime'

/**
 * Tells the owning renderer that a Companion mirror wrote to its PTY
 * (ADR-050): id and bytes, to the exact current owner and generation, so
 * ADR-019 arming stays in the renderer. The bytes are never logged here.
 */
export function installMirrorInputNotice(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  ptys: Pick<PtySupervisor, 'onMirrorInput'>,
  events: Pick<RendererEventPublisher, 'toRenderer'>,
): void {
  runtime.own(
    'mirror input notice',
    ptys.onMirrorInput((info, data) => {
      events.toRenderer(
        { id: info.ownerId, generation: info.ownerGeneration },
        'pty:mirror-input',
        { id: info.id, data },
      )
    }),
    (dispose) => dispose(),
  )
}
