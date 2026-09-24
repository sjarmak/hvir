/**
 * Parsed module facts across every repository reviewed on this machine (ADR-063). It lives
 * apart from the cache, which names the compiler's version, so the main process can size
 * the cache without loading the TypeScript compiler; parsing belongs to the worker.
 */
export const ARCHITECTURE_PARSE_CACHE_BYTES = 256 * 1024 * 1024
