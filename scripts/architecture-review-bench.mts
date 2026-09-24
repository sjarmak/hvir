#!/usr/bin/env node
// Usage: node scripts/architecture-review-bench.mts <absolute repo root> <mode> [--runs N] [--ssh]
//    or: npm run bench:architecture-review -- <absolute repo root> <mode> [--runs N] [--ssh]
// --ssh scans a repository on the target named by the HVIR_REAL_SSH_* environment contract.
// Prints per-stage timings and bytes for architecture capture plus analysis as JSON.
//
// The bench is bundled to CommonJS first, because the SSH host's dependencies (ssh2) are
// CommonJS and the app's extensionless TypeScript imports do not load under plain node.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const repository = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = join(repository, 'out/architecture-review-bench/architecture-review-bench.cjs')

await build({
  root: repository,
  configFile: join(repository, 'scripts/architecture-review-bench.vite.config.mts'),
  logLevel: 'error',
})
const bench = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], {
  cwd: repository,
  stdio: 'inherit',
})
if (bench.error) throw bench.error
process.exitCode = bench.status ?? 1
