import type { ArchitectureAnalysis, ArchitectureScanInput } from '../../shared'
import type { ArchitectureCapture } from '../../shared/architecture-review'
import { compareArchitecture, scanArchitecture } from './analysis'
import { cachedFactsSource } from './cached-facts'
import type { ScannerSet } from './language-scanner'
import type { ModuleFactsCache } from './module-facts-cache'
import { processClock, type ProcessClock } from './scan-recorder'
import { TYPESCRIPT_ONLY_SCANNERS } from './typescript-scanner'

/** One analysis stage, marked on the clock of the process that ran it. */
export interface TimedStage {
  readonly stage: 'parse' | 'compare'
  readonly side?: 'baseline' | 'current'
  readonly startMark: number
  readonly endMark: number
  readonly bytes: number
  readonly items: number
}

export interface TimedArchitectureAnalysis {
  readonly analysis: ArchitectureAnalysis
  readonly stages: readonly TimedStage[]
}

/** The scan inputs for both ends of one already-captured pair. */
export function captureScanInputs(
  capture: ArchitectureCapture,
): readonly [ArchitectureScanInput, ArchitectureScanInput] {
  const { exclusions, layout } = capture
  const scope = layout.scope.length ? layout.scope.join(', ') : 'repository source files'
  return [
    { files: capture.before, configs: capture.configs.before, scope, exclusions, layout },
    { files: capture.after, configs: capture.configs.after, scope, exclusions, layout },
  ]
}

/**
 * Analyze one captured pair, timing each end's parse and the comparison; no project host
 * I/O. With a cache, a module whose blob was parsed before costs a lookup, not a parse.
 */
export async function analyzeCaptureTimed(
  capture: ArchitectureCapture,
  clock: ProcessClock = processClock,
  cache?: ModuleFactsCache,
  scanners: ScannerSet = TYPESCRIPT_ONLY_SCANNERS,
): Promise<TimedArchitectureAnalysis> {
  const [baselineInput, currentInput] = captureScanInputs(capture)
  const facts = cachedFactsSource(cache, capture.root, scanners)
  const parse = async (input: ArchitectureScanInput, side: 'baseline' | 'current') => {
    const startMark = clock()
    await facts.load(input.files)
    const scanned = scanArchitecture(input, scanners, facts.factsOf)
    await facts.flush()
    const result = {
      ...scanned,
      diagnostics: [...scanned.diagnostics, ...facts.takeDiagnostics()],
    }
    const stage: TimedStage = {
      stage: 'parse',
      side,
      startMark,
      endMark: clock(),
      bytes: input.files.reduce(
        (total, file) => total + Buffer.byteLength(file.content),
        0,
      ),
      items: input.files.length,
    }
    return { result, stage }
  }
  const baseline = await parse(baselineInput, 'baseline')
  const current = await parse(currentInput, 'current')
  const compareStart = clock()
  const analysis = compareArchitecture(baseline.result, current.result)
  const compare: TimedStage = {
    stage: 'compare',
    startMark: compareStart,
    endMark: clock(),
    bytes: 0,
    items: analysis.imports.length,
  }
  return { analysis, stages: [baseline.stage, current.stage, compare] }
}
