import type { HostPath } from '../../shared/host-path'
import type { ExecOptions } from './project-host'

type RemoteCommandOptions = Pick<ExecOptions, 'cwd' | 'env' | 'unsetEnv'> & {
  readonly pathPrefix?: HostPath
}

export function remoteCommand(
  command: string,
  args: readonly string[],
  opts: RemoteCommandOptions,
  loginShell?: string,
): string {
  const executable = [command, ...args].map(quoteSshArgument).join(' ')
  const unset = (opts.unsetEnv ?? [])
    .map((key) => `-u ${quoteSshArgument(key)}`)
    .join(' ')
  const prefix = opts.pathPrefix
  if (prefix && prefix.hostId !== opts.cwd?.hostId)
    throw new Error('Command directory belongs to another host')
  const env = Object.entries(opts.env ?? {})
    .filter(([key]) => !prefix || key !== 'PATH')
    .map(([k, v]) => `${k}=${quoteSshArgument(v)}`)
    .join(' ')
  const path = prefix
    ? `PATH=${quoteSshArgument(prefix.path)}:${opts.env?.['PATH'] !== undefined ? quoteSshArgument(opts.env['PATH']) : '"$PATH"'}`
    : ''
  const environment = [unset, env, path].filter(Boolean).join(' ')
  const invocation = environment ? `env ${environment} ${executable}` : executable
  const withCwd = opts.cwd
    ? `cd -- ${quoteSshArgument(opts.cwd.path)} && ${invocation}`
    : invocation
  return loginShell
    ? `${quoteSshArgument(loginShell)} -l -c ${quoteSshArgument(withCwd)}`
    : withCwd
}

export function remoteBufferedCommand(
  command: string,
  args: readonly string[],
  opts: RemoteCommandOptions,
  statusMarker: string,
  loginShell?: string,
): string {
  const invocation = remoteCommand(command, args, opts, loginShell)
  return `( ${invocation} ); hvir_status=$?; printf '%s%s' ${quoteSshArgument(statusMarker)} "$hvir_status" >&2; exit "$hvir_status"`
}

export function recoverBufferedExecStatus(
  stderr: string,
  statusMarker: string,
): { readonly code?: number; readonly stderr: string } {
  const markerAt = stderr.lastIndexOf(statusMarker)
  if (markerAt < 0) return { stderr }
  const rawCode = stderr.slice(markerAt + statusMarker.length)
  if (!/^\d{1,3}$/.test(rawCode)) return { stderr }
  const code = Number(rawCode)
  if (!Number.isSafeInteger(code) || code > 255) return { stderr }
  return { code, stderr: stderr.slice(0, markerAt) }
}

export function quoteSshArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
