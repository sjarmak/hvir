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
    const stream = host.execStream(spec.file, spec.args, {
      cwd: request.workspaceRoot,
      env: spec.env,
      unsetEnv: resolved.unsetEnvironment,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]),
      keepStdinOpen: true,
      loginShell: spec.shellEnvironment,
      maxBuffer: MAX_OUTPUT_BYTES,
    })
    return new Promise<string>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let outputBytes = 0
      let settled = false
      const finish = (result: () => void) => {
        if (settled) return
        settled = true
        stream.dispose()
        result()
      }
      stream.onStdout((chunk) => {
        outputBytes += Buffer.byteLength(chunk, 'utf8')
        if (outputBytes > MAX_OUTPUT_BYTES) {
          finish(() =>
            reject(
              new Error(
                `Architecture explanation model output exceeded ${MAX_OUTPUT_BYTES} bytes`,
              ),
            ),
          )
          return
        }
        stdout += chunk
        request.onOutput(stdout)
      })
      stream.onStderr((chunk) => {
        outputBytes += Buffer.byteLength(chunk, 'utf8')
        if (outputBytes > MAX_OUTPUT_BYTES) {
          finish(() =>
            reject(
              new Error(
                `Architecture explanation model output exceeded ${MAX_OUTPUT_BYTES} bytes`,
              ),
            ),
          )
          return
        }
        stderr += chunk
      })
      stream.onError((error) => finish(() => reject(error)))
      stream.onExit(({ code }) => {
        if (code === 0) {
          finish(() => resolve(stdout.trim()))
          return
        }
        const detail = stderr.trim() || stdout.trim()
        finish(() =>
          reject(
            new Error(
              detail
                ? `Architecture explanation model failed: ${detail}`
                : 'Architecture explanation model failed',
            ),
          ),
        )
      })
      void stream
        .end(request.prompt)
        .catch((error: unknown) =>
          finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
        )
    })
  }
}
