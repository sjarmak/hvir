import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererEventPublisher } from '../renderer-event-publisher'
import type { WorkbenchRuntime } from '../workbench-runtime'

/**
 * Tells the owning renderer that a Companion page watching its PTY holds the size, or that
 * the hold ended (ADR-058): the id and the held grid, to the exact current owner and
 * generation, so the pane can present a size it did not choose and refit once it is its
 * own again.
 */
export function installMirrorGeometryNotice(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  ptys: Pick<PtySupervisor, 'onMirrorGeometry'>,
  events: Pick<RendererEventPublisher, 'toRenderer'>,
): void {
  runtime.own(
    'mirror geometry notice',
    ptys.onMirrorGeometry((event) => {
      const owner = { id: event.ownerId, generation: event.ownerGeneration }
      if (event.kind === 'held') {
        const { cols, rows } = event.geometry
        events.toRenderer(owner, 'pty:mirror-geometry', {
          id: event.id,
          kind: 'held',
          cols,
          rows,
        })
      } else {
        events.toRenderer(owner, 'pty:mirror-geometry', { id: event.id, kind: 'reclaim' })
      }
    }),
    (dispose) => dispose(),
  )
}
