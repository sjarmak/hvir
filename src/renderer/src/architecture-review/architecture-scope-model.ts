import { architectureScopeProblem } from '../../../shared/architecture-layout'
import type { ArchitectureScopeCandidate } from '../../../shared/architecture-scope'

export interface ParsedScope {
  readonly scope: readonly string[]
  /** Why the layout file would refuse this scope; absent when it can be saved. */
  readonly problem?: string
}

/** One path per line; an empty scope means the whole repository. */
export function scopeFromText(text: string): ParsedScope {
  const scope = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const problem = architectureScopeProblem(scope)
  return problem === undefined ? { scope } : { scope, problem }
}

export function scopeText(scope: readonly string[]): string {
  return scope.join('\n')
}

/** Adds `path` to the scope text, or removes it when it is already there. */
export function toggleScopePath(text: string, path: string): string {
  const { scope } = scopeFromText(text)
  return scopeText(
    scope.includes(path) ? scope.filter((entry) => entry !== path) : [...scope, path],
  )
}

export function candidateLabel(candidate: ArchitectureScopeCandidate): string {
  const files = `${candidate.files.toLocaleString('en-US')} ${candidate.files === 1 ? 'file' : 'files'}`
  return candidate.bytes === null
    ? `${candidate.path} · ${files}`
    : `${candidate.path} · ${files} · ${(candidate.bytes / (1024 * 1024)).toFixed(1)} MiB`
}
