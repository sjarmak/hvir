import { join } from 'node:path'
import type { WorkerRequest, WorkerResponse } from '../shared/worker-protocol'
import { localPath } from '../shared/host-path'
import { loadArchitectureScanners } from '../main/architecture-review/architecture-scanners'
import { TREE_SITTER_ASSET_DIRECTORY } from '../main/architecture-review/tree-sitter-assets'
import { analyzeCaptureTimed } from '../main/architecture-review/timed-analysis'
import { ModuleFactsCache } from '../main/architecture-review/module-facts-cache'
import { LocalHost } from '../main/project-host/local-host'
import { processClock } from '../main/architecture-review/scan-recorder'
import { translateClock } from '../main/architecture-review/wall-clock'
import { reportWorkerTimings } from '../main/architecture-review/worker-timings'
import type {
  ArchitectureParseCacheLocation,
  ArchitectureWorkerRequest,
  ArchitectureWorkerResult,
} from '../main/architecture-review/worker'

interface ParentPort {
  on(
    event: 'message',
    listener: (event: { data: WorkerRequest<ArchitectureWorkerRequest> }) => void,
  ): void
  postMessage(message: WorkerResponse<ArchitectureWorkerResult>): void
}
const port = (process as unknown as { parentPort?: ParentPort }).parentPort
if (!port) throw new Error('Architecture analysis requires a utility process')

// The process stays warm between scans, so the cache index is read from disk once. The
// cache is this machine's application state, so it is always kept through the local host.
const files = new LocalHost()

// The grammars ship beside this bundle (inside app.asar when packaged) and load once per
// process. The ready mark follows them, so spawn cost includes module and grammar loading.
const ready = loadArchitectureScanners((asset) =>
  files.readFile(localPath(join(__dirname, TREE_SITTER_ASSET_DIRECTORY, asset.file))),
).then((scanners) => ({ scanners, readyMark: processClock() }))
// A failed load is reported to every request below; handled here so it cannot end the process.
ready.catch(() => undefined)
let cache: { readonly location: string; readonly cache: ModuleFactsCache } | undefined
function cacheFor(
  location: ArchitectureParseCacheLocation | undefined,
): ModuleFactsCache | undefined {
  if (!location) return undefined
  const key = JSON.stringify([location.directory, location.maxBytes])
  if (cache?.location !== key)
    cache = { location: key, cache: new ModuleFactsCache({ ...location, files }) }
  return cache.cache
}

async function answer(
  channel: ParentPort,
  data: WorkerRequest<ArchitectureWorkerRequest>,
): Promise<void> {
  try {
    // A request that arrives while the grammars load is received once they are ready.
    const { scanners, readyMark } = await ready
    const receivedMark = processClock()
    if (data.type !== 'analyze') throw new Error('Unknown architecture analysis request')
    const { capture, cache: location } = data.payload
    const { analysis, stages } = await analyzeCaptureTimed(
      capture,
      processClock,
      cacheFor(location),
      scanners,
    )
    // Marked before sizing the result, so serializing it counts toward worker-return.
    const respondedMark = processClock()
    const resultBytes = Buffer.byteLength(JSON.stringify(analysis))
    const marks = { readyMark, receivedMark, respondedMark, resultBytes, stages }
    channel.postMessage({
      id: data.id,
      ok: true,
      result: { analysis, timings: reportWorkerTimings(marks, translateClock()) },
    })
  } catch (error) {
    channel.postMessage({
      id: data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

port.on('message', ({ data }) => void answer(port, data))
