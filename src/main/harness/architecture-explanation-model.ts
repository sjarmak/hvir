import { randomUUID } from 'node:crypto'
import type { ProjectHost } from '../project-host'
import type {
  ArchitectureExplanationModelPort,
  ArchitectureExplanationModelRequest,
} from '../architecture-review/explanation-model'
import { resolveHarnessLaunch } from './harness-launch'
import type { HarnessProfileStoreContract } from './harness-profile-store'

const MAX_OUTPUT_BYTES = 128 * 1024
const MODEL_TIMEOUT_MS = 120_000

export class HarnessArchitectureExplanationModel implements ArchitectureExplanationModelPort {
  constructor(private readonly profiles: HarnessProfileStoreContract) {}

  async generate(
    host: ProjectHost,
    request: ArchitectureExplanationModelRequest,
  ): Promise<string> {
    const profile = this.profiles.get(request.profileId)
    if (!profile) throw new Error(`Unknown harness profile '${request.profileId}'`)
    if (profile.executable.kind !== 'provider-default' || profile.args.length !== 0) {
      throw new Error(
        'Architecture explanation requires a supported provider, its default executable, and no custom arguments.',
      )
    }
    const resolved = await resolveHarnessLaunch({
      profile,
      expectedLaunchRevision: request.launchRevision,
      projectRoot: request.projectRoot,
      workspaceRoot: request.workspaceRoot,
      host,
      store: this.profiles,
      mode: 'fresh',
      context: {
        sessionId: randomUUID(),
        cwd: request.workspaceRoot,
        defaultShell: await host.defaultShell(),
      },
    })
    const spec = resolved.provider.architectureExplanation?.(resolved.spec)
    if (!spec) throw new Error('This harness provider cannot explain architecture')
    const result = await host.exec(spec.file, spec.args, {
      cwd: request.workspaceRoot,
      env: spec.env,
      unsetEnv: resolved.unsetEnvironment,
      input: request.prompt,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]),
      loginShell: spec.shellEnvironment,
      maxBuffer: MAX_OUTPUT_BYTES,
    })
    if (result.code !== 0) {
      const detail = result.stderr.trim()
      throw new Error(
        detail
          ? `Architecture explanation model failed: ${detail}`
          : 'Architecture explanation model failed',
      )
    }
    return result.stdout.trim()
  }
}
