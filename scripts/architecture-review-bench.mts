#!/usr/bin/env node
// Usage: node scripts/architecture-review-bench.mts <absolute repo root> <mode> [--runs N]
// Prints per-stage timings and bytes for architecture capture plus analysis as JSON.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runnerImport } from 'vite'

type BenchModule = typeof import('./architecture-review-bench-run.mts')

const repository = join(dirname(fileURLToPath(import.meta.url)), '..')
// Vite's module runner resolves the app's extensionless TypeScript imports.
const { module } = await runnerImport<BenchModule>(
  join(repository, 'scripts/architecture-review-bench-run.mts'),
  { root: repository, configFile: false, logLevel: 'error' },
)
try {
  const report = await module.runArchitectureReviewBench(
    module.parseBenchArguments(process.argv.slice(2)),
  )
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
