import type { HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import { GasCityService } from './gascity-service'

/**
 * Construct the GasCityService. It holds no watches or timers — the crew view
 * polls while visible — so there is nothing to dispose, and the composition
 * root's Gas City footprint stays a single call.
 */
export function ownGasCityService(
  getProject: () => { readonly host: ProjectHost; readonly root: HostPath },
): GasCityService {
  return new GasCityService({ getProject })
}
