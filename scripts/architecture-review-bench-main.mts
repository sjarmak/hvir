// Bundle entry for scripts/architecture-review-bench.mts, which builds and runs it.
// Prints per-stage timings and bytes for architecture capture plus analysis as JSON.
import {
  parseBenchArguments,
  runArchitectureReviewBench,
} from './architecture-review-bench-run.mts'

async function main(): Promise<void> {
  const report = await runArchitectureReviewBench(
    parseBenchArguments(process.argv.slice(2)),
  )
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
