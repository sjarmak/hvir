import type { HostPath } from '../../shared'
import type { EmitRendererEvent } from '../ipc'
import type { ProjectHost } from '../project-host'
import type { WorkbenchRuntime } from '../workbench-runtime'
import { BeadsService } from './beads-service'

/**
 * Construct the BeadsService and register it for disposal on the workbench
 * runtime, wiring `.beads` change events onto the renderer emit. Keeps the
 * composition root's beads footprint to a single call.
 */
export function ownBeadsService(
  runtime: WorkbenchRuntime,
  getProject: () => { readonly host: ProjectHost; readonly root: HostPath },
  emit: EmitRendererEvent,
): BeadsService {
  return runtime.own(
    'beads service',
    new BeadsService({
      getProject,
      emitChanged: (event) => emit('beads:changed', event),
    }),
    (service) => service.dispose(),
  )
}
