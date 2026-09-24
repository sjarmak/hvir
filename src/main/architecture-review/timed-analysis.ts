import type { ArchitectureAnalysis, ArchitectureScanInput } from '../../shared'
import type { ArchitectureCapture } from '../../shared/architecture-review'
import { compareArchitecture, scanArchitecture } from './analysis'
import { epochClock, type EpochClock } from './scan-recorder'

/** One analysis stage timed in the process that ran it, on the wall clock. */
export interface EpochStage {
  readonly stage: 'parse' | 'compare'
  readonly side?: 'baseline' | 'current'
  readonly startEpochMs: number
  readonly endEpochMs: number
  readonly bytes: number
  readonly items: number
}

export interface TimedArchitectureAnalysis {
  readonly analysis: ArchitectureAnalysis
  readonly stages: readonly EpochStage[]
}

/** The scan inputs for both ends of one already-captured pair. */
export function captureScanInputs(
  capture: ArchitectureCapture,
): readonly [ArchitectureScanInput, ArchitectureScanInput] {
  const scope = 'repository source files'
  const exclusions = capture.exclusions
  return [
    { files: capture.before, scope, exclusions },
    { files: capture.after, scope, exclusions },
  ]
}

/** Analyze one captured pair, timing each end's parse and the comparison; no host I/O. */
export function analyzeCaptureTimed(
  capture: ArchitectureCapture,
  clock: EpochClock = epochClock,
): TimedArchitectureAnalysis {
  const [baselineInput, currentInput] = captureScanInputs(capture)
  const parse = (input: ArchitectureScanInput, side: 'baseline' | 'current') => {
    const startEpochMs = clock()
    const result = scanArchitecture(input)
    const stage: EpochStage = {
      stage: 'parse',
      side,
      startEpochMs,
      endEpochMs: clock(),
      bytes: input.files.reduce(
        (total, file) => total + Buffer.byteLength(file.content),
        0,
      ),
      items: input.files.length,
    }
    return { result, stage }
  }
  const baseline = parse(baselineInput, 'baseline')
  const current = parse(currentInput, 'current')
  const compareStart = clock()
  const analysis = compareArchitecture(baseline.result, current.result)
  const compare: EpochStage = {
    stage: 'compare',
    startEpochMs: compareStart,
    endEpochMs: clock(),
    bytes: 0,
    items: analysis.imports.length,
  }
  return { analysis, stages: [baseline.stage, current.stage, compare] }
}
