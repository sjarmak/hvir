import type { ArchitectureAnalysis } from '../../shared/architecture-analysis'
import { ARCHITECTURE_SCOPE } from '../../shared/architecture-review'
import { ByteBoundedCache } from './byte-bounded-cache'

export const ARCHITECTURE_BLOB_CACHE_BYTES = 2 * ARCHITECTURE_SCOPE.maxTotalBytes
export const ARCHITECTURE_ANALYSIS_CACHE_BYTES = 32 * 1024 * 1024

export type ArchitectureBlobCache = ByteBoundedCache<string>
export type ArchitectureAnalysisCache = ByteBoundedCache<ArchitectureAnalysis>

export function architectureBlobCache(): ArchitectureBlobCache {
  return new ByteBoundedCache(ARCHITECTURE_BLOB_CACHE_BYTES)
}

export function architectureAnalysisCache(): ArchitectureAnalysisCache {
  return new ByteBoundedCache(ARCHITECTURE_ANALYSIS_CACHE_BYTES)
}
