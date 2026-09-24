import {
  ARCHITECTURE_LAYOUT_FILE,
  ArchitectureLayoutError,
  architectureScopeProblem,
  parseArchitectureLayout,
} from '../../shared/architecture-layout'
import type { ArchitectureScopeRecord } from '../../shared/architecture-scope'
import { dirnameHostPath, type HostPath } from '../../shared/host-path'
import { isProjectPathExistsError, type ProjectHost } from '../project-host/project-host'

/**
 * Records the reviewer's scope in the working tree's layout file (ADR-063), keeping every
 * other key as written. `file` is the layout file's path, already authorized inside the
 * workspace. An empty scope means the whole repository and removes the key.
 */
export async function recordArchitectureScope(
  host: ProjectHost,
  file: HostPath,
  scope: readonly string[],
): Promise<ArchitectureScopeRecord> {
  if (!Array.isArray(scope)) throw new Error('Invalid architecture scope')
  const problem = architectureScopeProblem(scope)
  if (problem !== undefined) throw new Error(`Invalid architecture scope: ${problem}`)
  const existing = await readExisting(host, file)
  if (!existing && scope.length === 0) return { scope, written: false }
  const text = layoutWithScope(existing?.text, scope)
  if (existing) {
    await host.writeFile(file, text, { expectedMtimeMs: existing.mtimeMs })
  } else {
    await ensureDirectory(host, dirnameHostPath(file))
    await host.writeFile(file, text)
  }
  return { scope, written: true }
}

/** The layout text with `scope` in place of the old one, after `version`. */
export function layoutWithScope(
  text: string | undefined,
  scope: readonly string[],
): string {
  const {
    version,
    scope: _replaced,
    ...rest
  } = text === undefined ? { version: 1 } : validated(text)
  const next = { version, ...(scope.length ? { scope } : {}), ...rest }
  const result = `${JSON.stringify(next, null, 2)}\n`
  validated(result)
  return result
}

function validated(text: string): Readonly<Record<string, unknown>> {
  try {
    parseArchitectureLayout(text)
  } catch (error) {
    if (!(error instanceof ArchitectureLayoutError)) throw error
    throw new Error(
      `Invalid ${ARCHITECTURE_LAYOUT_FILE} in the working tree: ${error.message}`,
      { cause: error },
    )
  }
  return JSON.parse(text) as Readonly<Record<string, unknown>>
}

async function readExisting(
  host: ProjectHost,
  file: HostPath,
): Promise<{ readonly text: string; readonly mtimeMs: number } | undefined> {
  let entry: Awaited<ReturnType<ProjectHost['stat']>>
  try {
    entry = await host.stat(file)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  if (entry.type !== 'file')
    throw new Error(`${ARCHITECTURE_LAYOUT_FILE} is not a regular file`)
  return { text: await host.readTextFile(file), mtimeMs: entry.mtimeMs }
}

async function ensureDirectory(host: ProjectHost, directory: HostPath): Promise<void> {
  try {
    await host.createDirectoryExclusive(directory, { mode: 0o755 })
  } catch (error) {
    if (!isProjectPathExistsError(error)) throw error
  }
}

/** Local hosts report ENOENT; SFTP reports status 2 (no such file). */
function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 2
}
