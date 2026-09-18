/**
 * The Companion's asset allowlist (ADR-049): the page itself and the flat
 * bundle files beside it, read through the project host so main never opens
 * a file by path on its own. Anything the allowlist does not name resolves to
 * nothing before the host is asked, so a traversal never reaches the disk.
 */
import { join } from 'node:path'

import { localPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import { COMPANION_INDEX_PATH, type CompanionAssetReader } from './companion-auth'

/** Media types for the bundle files the reader may serve, by extension. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR'])

export type CompanionAssetHost = Pick<ProjectHost, 'readFile'>

/**
 * Reads allowlisted bundle files under `root` (the built renderer directory).
 * `companion/index.html` is the page; `assets/<file>` is one flat bundle
 * file whose name carries no separator and ends in a known extension.
 */
export function createCompanionAssetReader(
  host: CompanionAssetHost,
  root: string,
): CompanionAssetReader {
  return {
    read: async (relativePath) => {
      const resolved = resolveAllowlisted(relativePath)
      if (resolved === undefined) return undefined
      const body = await readOrMissing(host, join(root, ...resolved.segments))
      return body === undefined ? undefined : { body, contentType: resolved.contentType }
    },
  }
}

interface AllowlistedAsset {
  readonly segments: readonly string[]
  readonly contentType: string
}

function resolveAllowlisted(relativePath: string): AllowlistedAsset | undefined {
  if (relativePath === COMPANION_INDEX_PATH) {
    return { segments: ['companion', 'index.html'], contentType: CONTENT_TYPES['.html']! }
  }
  if (!relativePath.startsWith('assets/')) return undefined
  const name = relativePath.slice('assets/'.length)
  if (!ASSET_NAME.test(name)) return undefined
  const contentType = CONTENT_TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()]
  return contentType === undefined
    ? undefined
    : { segments: ['assets', name], contentType }
}

async function readOrMissing(
  host: CompanionAssetHost,
  path: string,
): Promise<Uint8Array | undefined> {
  try {
    return await host.readFile(localPath(path))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    MISSING_CODES.has(error.code)
  )
}
