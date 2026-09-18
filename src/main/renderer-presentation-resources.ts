import type { ApplicationAttention } from './attention/attention-owner'
import type { DiagnosticReportCoordinator } from './diagnostics/diagnostic-report-coordinator'
import type { RendererSshPrompter } from './project-host'
import type { RendererOwner, RendererResourceScopes } from './renderer-resource-scopes'

interface RendererPresentationResources {
  readonly scopes: RendererResourceScopes
  readonly reports: DiagnosticReportCoordinator
  readonly attention: () => Pick<ApplicationAttention, 'removeOwner'> | null
  readonly sshPrompter: () => RendererSshPrompter | null
}

/** Registers renderer-lifetime presentation resources at one composition seam. */
export function createRendererPresentationInstaller(
  resources: RendererPresentationResources,
): (owner: RendererOwner) => RendererOwner {
  return (owner) => {
    resources.scopes.register(owner, { lifetime: 'renderer', type: 'attention' }, () =>
      resources.attention()?.removeOwner(owner),
    )
    resources.scopes.register(
      owner,
      { lifetime: 'renderer', type: 'ssh-prompt-presentation' },
      () => resources.sshPrompter()?.revokeOwner(owner),
    )
    resources.scopes.register(
      owner,
      { lifetime: 'renderer', type: 'diagnostic-report' },
      () => resources.reports.revoke(owner),
    )
    return owner
  }
}
