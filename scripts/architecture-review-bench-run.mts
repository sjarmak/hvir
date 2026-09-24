import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureArchitecture } from '../src/main/architecture-review/capture'
import {
  ModuleFactsCache,
  type ModuleFactsCacheStats,
} from '../src/main/architecture-review/module-facts-cache'
import { ARCHITECTURE_PARSE_CACHE_BYTES } from '../src/main/architecture-review/parse-cache-budget'
import { ArchitectureScanRecorder } from '../src/main/architecture-review/scan-recorder'
import { analyzeCaptureTimed } from '../src/main/architecture-review/timed-analysis'
import { hostPath } from '../src/shared/host-path'
import type { ProjectHost } from '../src/main/project-host/project-host'
import { LocalHost } from '../src/main/project-host/local-host'
import type { ArchitectureComparisonMode } from '../src/shared/architecture-review'
import {
  ARCHITECTURE_SCAN_STAGES,
  summarizeArchitectureStages,
  type ArchitectureScanMetrics,
  type ArchitectureStageTotal,
} from '../src/shared/architecture-scan-metrics'
import {
  openArchitectureBenchHost,
  type BenchHostKind,
  type BenchHostOpener,
} from './architecture-review-bench-host.mts'

const MODES = ['working-tree', 'head', 'branch-point'] as const
type BenchMode = (typeof MODES)[number] & ArchitectureComparisonMode
/**
 * cold: every sample starts from an empty parse cache, as the first scan of a repository.
 * warm: one unsampled scan fills the cache, then every sample reuses it, as a warm worker.
 */
const CACHE_MODES = ['cold', 'warm'] as const
type BenchCache = (typeof CACHE_MODES)[number]

export interface BenchArguments {
  readonly root: string
  readonly mode: BenchMode
  readonly runs: number
  readonly host: BenchHostKind
  readonly cache: BenchCache
}
type StageMedian = Omit<ArchitectureStageTotal, 'spans'>
export interface BenchReport extends BenchArguments {
  /** 'local', or user@hostname:port for an SSH target. */
  readonly target: string
  readonly files: { readonly baseline: number; readonly current: number }
  readonly note: string
  readonly median: { readonly totalMs: number; readonly stages: readonly StageMedian[] }
  readonly samples: readonly {
    readonly totalMs: number
    readonly stages: readonly ArchitectureStageTotal[]
    readonly cache: Pick<ModuleFactsCacheStats, 'hits' | 'misses' | 'discarded'>
  }[]
}

const USAGE = 'Usage: <root> <mode> [--runs N] [--ssh] [--cache cold|warm]'

export function parseBenchArguments(argv: readonly string[]): BenchArguments {
  const [root, mode, ...flags] = argv
  if (!root?.startsWith('/'))
    throw new Error('Pass the repository root as an absolute path')
  if (!MODES.includes(mode as BenchMode))
    throw new Error(`Pass a comparison mode: ${MODES.join(', ')}`)
  let runs: number | undefined
  let host: BenchHostKind | undefined
  let cache: BenchCache | undefined
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]
    if (flag === '--runs' && runs === undefined) {
      index += 1
      runs = Number(flags[index])
      if (!Number.isSafeInteger(runs) || runs < 1 || runs > 50)
        throw new Error('--runs must be an integer from 1 to 50')
    } else if (flag === '--ssh' && host === undefined) host = 'ssh'
    else if (flag === '--cache' && cache === undefined) {
      index += 1
      cache = flags[index] as BenchCache
      if (!CACHE_MODES.includes(cache)) throw new Error('--cache must be cold or warm')
    } else throw new Error(USAGE)
  }
  return {
    root,
    mode: mode as BenchMode,
    runs: runs ?? 1,
    host: host ?? 'local',
    cache: cache ?? 'cold',
  }
}

export function medianOf(values: readonly number[]): number {
  if (values.length === 0) throw new Error('A median needs at least one value')
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * Capture through the chosen host and analysis on this machine, as the app runs them, minus
 * the utility process: worker spawn and transfer appear only in the app.
 */
export async function runArchitectureReviewBench(
  args: BenchArguments,
  openHost: BenchHostOpener = openArchitectureBenchHost,
): Promise<BenchReport> {
  const { host, target, dispose } = await openHost(args.host)
  const samples: Sample[] = []
  const directory = mkdtempSync(join(tmpdir(), 'hvir-architecture-bench-cache-'))
  try {
    samples.push(...(await sampleScans(host, args, directory)))
  } finally {
    rmSync(directory, { recursive: true, force: true })
    await dispose()
  }
  const totals = samples.map((sample) =>
    summarizeArchitectureStages(sample.metrics.spans),
  )
  return {
    ...args,
    target,
    files: { baseline: samples[0]!.baseline, current: samples[0]!.current },
    note: `Analysis runs in-process with a ${args.cache} parse cache; worker spawn and transfer are measured only in the app.`,
    median: {
      totalMs: medianOf(samples.map((sample) => sample.metrics.totalMs)),
      stages: medianStages(totals),
    },
    samples: samples.map((sample, index) => ({
      totalMs: sample.metrics.totalMs,
      stages: totals[index]!,
      cache: sample.cache,
    })),
  }
}

interface Sample {
  readonly metrics: ArchitectureScanMetrics
  readonly baseline: number
  readonly current: number
  readonly cache: Pick<ModuleFactsCacheStats, 'hits' | 'misses' | 'discarded'>
}

async function sampleScans(
  host: ProjectHost,
  args: BenchArguments,
  directory: string,
): Promise<Sample[]> {
  const files = new LocalHost()
  const open = (run: number) =>
    new ModuleFactsCache({
      files,
      directory: join(directory, String(run)),
      maxBytes: ARCHITECTURE_PARSE_CACHE_BYTES,
    })
  const shared = args.cache === 'warm' ? open(0) : undefined
  if (shared) await scanOnce(host, args, shared)
  const samples: Sample[] = []
  for (let run = 1; run <= args.runs; run += 1)
    samples.push(await scanOnce(host, args, shared ?? open(run)))
  return samples
}

async function scanOnce(
  host: ProjectHost,
  args: BenchArguments,
  cache: ModuleFactsCache,
): Promise<Sample> {
  const before = cache.stats()
  const recorder = new ArchitectureScanRecorder()
  const capture = await captureArchitecture(
    host,
    { root: hostPath(host.hostId, args.root), mode: args.mode },
    AbortSignal.timeout(300_000),
    recorder,
  )
  const timed = await analyzeCaptureTimed(capture, undefined, cache)
  for (const stage of timed.stages)
    recorder.place(stage.stage, stage.startMark, stage.endMark, stage)
  const { before: _before, after: _after, configs: _configs, ...metadata } = capture
  recorder.measureSync(
    'renderer-payload',
    () => Buffer.byteLength(JSON.stringify({ ...metadata, analysis: timed.analysis })),
    (bytes) => ({ bytes, items: 1 }),
  )
  const after = cache.stats()
  return {
    metrics: recorder.metrics(),
    baseline: capture.before.length,
    current: capture.after.length,
    cache: {
      hits: after.hits - before.hits,
      misses: after.misses - before.misses,
      discarded: after.discarded - before.discarded,
    },
  }
}

function medianStages(
  runs: readonly (readonly ArchitectureStageTotal[])[],
): StageMedian[] {
  return ARCHITECTURE_SCAN_STAGES.flatMap((stage) => {
    const matching = runs.flatMap((totals) =>
      totals.filter((total) => total.stage === stage),
    )
    if (matching.length === 0) return []
    const median = (read: (total: ArchitectureStageTotal) => number) =>
      medianOf(matching.map(read))
    return [
      {
        stage,
        durationMs: median((total) => total.durationMs),
        bytes: median((total) => total.bytes),
        items: median((total) => total.items),
        hostCalls: median((total) => total.hostCalls),
      },
    ]
  })
}
