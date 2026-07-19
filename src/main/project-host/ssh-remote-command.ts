import type { ExecOptions } from './project-host'

/**
 * Builds the POSIX shell command lines the SshHost sends over an exec channel.
 * Pure string construction with no ssh2 dependency, split out of the adapter so
 * the quoting/login-shell/buffered-status policy is defined — and unit-tested —
 * in one place.
 */

export function remoteCommand(
  command: string,
  args: readonly string[],
  opts: Pick<ExecOptions, 'cwd' | 'env' | 'unsetEnv'>,
  loginShell?: string,
): string {
  const executable = [command, ...args].map(quote).join(' ')
  const unset = (opts.unsetEnv ?? []).map((key) => `-u ${quote(key)}`).join(' ')
  const env = Object.entries(opts.env ?? {})
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join(' ')
  const environment = [unset, env].filter(Boolean).join(' ')
  const invocation = environment ? `env ${environment} ${executable}` : executable
  const withCwd = opts.cwd ? `cd -- ${quote(opts.cwd.path)} && ${invocation}` : invocation
  // Route through the login shell so a profile-configured PATH (~/.local/bin,
  // Homebrew, …) is sourced before the command runs. cwd and env stay inside
  // that shell so they still take effect. Separate `-l -c` flags keep shells
  // like fish that reject the combined `-lc` form working.
  return loginShell ? `${quote(loginShell)} -l -c ${quote(withCwd)}` : withCwd
}

export function remoteBufferedCommand(
  command: string,
  args: readonly string[],
  opts: Pick<ExecOptions, 'cwd' | 'env' | 'unsetEnv'>,
  statusMarker: string,
  loginShell?: string,
): string {
  const invocation = remoteCommand(command, args, opts, loginShell)
  return `( ${invocation} ); hvir_status=$?; printf '%s%s' ${quote(statusMarker)} "$hvir_status" >&2; exit "$hvir_status"`
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

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
