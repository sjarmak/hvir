import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadArchitectureScanners } from '../src/main/architecture-review/architecture-scanners'
import { captureArchitecture } from '../src/main/architecture-review/capture'
import type { ScannerSet } from '../src/main/architecture-review/language-scanner'
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
import { architectureRefProblem } from '../src/shared/architecture-review'
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

/**
 * cold: every sample starts from an empty parse cache, as the first scan of a repository.
 * warm: one unsampled scan fills the cache, then every sample reuses it, as a warm worker.
 */
const CACHE_MODES = ['cold', 'warm'] as const
type BenchCache = (typeof CACHE_MODES)[number]

export interface BenchArguments {
  readonly root: string
  /** Snapshot ends as the review takes them; omitted means branch point and live tree. */
  readonly baseline?: string
  readonly current?: string
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

const USAGE =
  'Usage: <root> [--baseline REF] [--current REF] [--runs N] [--ssh] [--cache cold|warm]'

type Flags = {
  runs?: number
  host?: BenchHostKind
  cache?: BenchCache
  baseline?: string
  current?: string
}

export function parseBenchArguments(argv: readonly string[]): BenchArguments {
  const [root, ...rest] = argv
  if (!root?.startsWith('/'))
    throw new Error('Pass the repository root as an absolute path')
  const flags: Flags = {}
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (flag === '--ssh' && flags.host === undefined) flags.host = 'ssh'
    else if (!parseValueFlag(flags, flag, value)) throw new Error(USAGE)
    else index += 1
  }
  return {
    root,
    ...(flags.baseline === undefined ? {} : { baseline: flags.baseline }),
    ...(flags.current === undefined ? {} : { current: flags.current }),
    runs: flags.runs ?? 1,
    host: flags.host ?? 'local',
    cache: flags.cache ?? 'cold',
  }
}

/** Applies one flag that takes a value; false when the flag is unknown or repeated. */
function parseValueFlag(
  flags: Flags,
  flag: string | undefined,
  value: string | undefined,
) {
  if (flag === '--runs' && flags.runs === undefined) {
    flags.runs = Number(value)
    if (!Number.isSafeInteger(flags.runs) || flags.runs < 1 || flags.runs > 50)
      throw new Error('--runs must be an integer from 1 to 50')
  } else if (flag === '--cache' && flags.cache === undefined) {
    if (!CACHE_MODES.includes(value as BenchCache))
      throw new Error('--cache must be cold or warm')
    flags.cache = value as BenchCache
  } else if (
    (flag === '--baseline' || flag === '--current') &&
    flags[flag.slice(2) as 'baseline' | 'current'] === undefined
  ) {
    const problem = architectureRefProblem(value)
    if (problem) throw new Error(`${flag} ref: ${problem}`)
    flags[flag.slice(2) as 'baseline' | 'current'] = value
  } else return false
  return true
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
  const require = createRequire(import.meta.url)
  const scanners = await loadArchitectureScanners((asset) =>
    Promise.resolve(readFileSync(require.resolve(asset.module))),
  )
  const shared = args.cache === 'warm' ? open(0) : undefined
  if (shared) await scanOnce(host, args, shared, scanners)
  const samples: Sample[] = []
  for (let run = 1; run <= args.runs; run += 1)
    samples.push(await scanOnce(host, args, shared ?? open(run), scanners))
  return samples
}

async function scanOnce(
  host: ProjectHost,
  args: BenchArguments,
  cache: ModuleFactsCache,
  scanners: ScannerSet,
): Promise<Sample> {
  const before = cache.stats()
  const recorder = new ArchitectureScanRecorder()
  const capture = await captureArchitecture(
    host,
    {
      root: hostPath(host.hostId, args.root),
      baseline: args.baseline,
      current: args.current,
    },
    AbortSignal.timeout(300_000),
    recorder,
  )
  const timed = await analyzeCaptureTimed(capture, undefined, cache, scanners)
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
