import { expect, it, vi } from 'vitest'
import { ArchitectureReviewCoordinator } from '../src/main/architecture-review/coordinator'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { localPath, hostPath, asHostId } from '../src/shared/host-path'
import type { ProjectHost } from '../src/main/project-host'
import type { ArchitectureCapture } from '../src/shared/architecture-review'
import type { ArchitectureAnalysis } from '../src/shared/architecture-analysis'
import type { ArchitectureScanRecorder } from '../src/main/architecture-review/scan-recorder'
import type { captureArchitecture } from '../src/main/architecture-review/capture'
import type { readArchitectureLiveState } from '../src/main/architecture-review/freshness'
import { expectMonotoneMetrics, stagesOf } from './architecture-scan-metrics-fixture'
import { gitBlobId } from '../src/main/architecture-review/blob-id'

const source = (path: string, content: string) => ({
  path,
  content,
  object: gitBlobId(Buffer.from(content)),
})
const root = localPath('/repo')
const snapshot: ArchitectureCapture = {
  root,
  mode: 'head',
  baselineRevision: 'abc',
  currentRevision: 'working-tree',
  fingerprint: 'fingerprint',
  before: [source('a.ts', 'before')],
  after: [],
  configs: { before: [], after: [] },
  exclusions: [],
  capturedAt: 'now',
}
function setup(
  capture = vi.fn<typeof captureArchitecture>(() => Promise.resolve(snapshot)),
) {
  const resources = new RendererResourceScopes()
  const owner = resources.activateOwner(1)
  const host = {
    hostId: root.hostId,
    connectionState: 'connected',
    onConnectionState: () => () => undefined,
  } as unknown as ProjectHost
  const emptyScan = {
    fingerprint: '',
    scope: 'test',
    exclusions: [],
    modules: [],
    imports: [],
    diagnostics: [],
  }
  const analyze = vi.fn<
    (
      capture: ArchitectureCapture,
      signal: AbortSignal,
      recorder: ArchitectureScanRecorder,
    ) => Promise<ArchitectureAnalysis>
  >(() =>
    Promise.resolve({
      before: emptyScan,
      after: emptyScan,
      modules: [],
      relationships: [],
      imports: [],
    }),
  )
  const liveState = vi.fn<typeof readArchitectureLiveState>(() =>
    Promise.resolve('live-state'),
  )
  const coordinator = new ArchitectureReviewCoordinator({
    resources,
    capture,
    liveState,
    analyze,
  })
  return {
    liveState,
    resources,
    owner,
    host,
    coordinator,
    capture,
    analyze,
    request: { root, mode: 'head' as const, reviewId: 'tab-1' },
  }
}
it('returns captured deleted-source evidence and rejects a different host or renderer', async () => {
  const f = setup()
  const result = await f.coordinator.scan(f.owner, f.host, f.request)
  for (const retained of ['before', 'after', 'configs'])
    expect(result).not.toHaveProperty(retained)
  const evidence = await f.coordinator.evidence(f.owner, f.host, {
    root,
    reviewId: 'tab-1',
    snapshotId: result.id,
    path: localPath('/repo/a.ts'),
  })
  expect(evidence.diff.baseInput.content).toBe('before')
  expect(evidence.diff.currentInput.content).toBe('')
  await expect(
    f.coordinator.evidence(f.owner, f.host, {
      root,
      reviewId: 'tab-1',
      snapshotId: result.id,
      path: hostPath(asHostId('ssh'), '/repo/a.ts'),
    }),
  ).rejects.toThrow(/evidence/)
  await expect(
    f.coordinator.evidence({ id: 2, generation: 1 }, f.host, {
      root,
      reviewId: 'tab-1',
      snapshotId: result.id,
      path: localPath('/repo/a.ts'),
    }),
  ).rejects.toThrow()
})
it('marks a changed live state stale while keeping the pinned pair, without recapture', async () => {
  const f = setup()
  const result = await f.coordinator.scan(f.owner, f.host, f.request)
  f.liveState.mockResolvedValue('edited')
  const evidence = await f.coordinator.evidence(f.owner, f.host, {
    root,
    reviewId: 'tab-1',
    snapshotId: result.id,
    path: localPath('/repo/a.ts'),
  })
  expect(evidence.stale).toBe(true)
  expect(evidence.diff.baseInput.content).toBe('before')
  expect(f.capture).toHaveBeenCalledTimes(1)
})
it('revokes pending capture on workspace close and rejects its late completion', async () => {
  let resolve!: (value: ArchitectureCapture) => void
  const f = setup(
    vi.fn<typeof captureArchitecture>(
      () =>
        new Promise<ArchitectureCapture>((done) => {
          resolve = done
        }),
    ),
  )
  const pending = f.coordinator.scan(f.owner, f.host, f.request)
  const rejected = expect(pending).rejects.toThrow(/cancel|revoked/i)
  await vi.waitFor(() => expect(f.capture).toHaveBeenCalled())
  await f.resources.revokeWorkspace(root)
  resolve(snapshot)
  await rejected
  expect(f.analyze).not.toHaveBeenCalled()
})
it('cancels an analysis and prevents old completion overwriting a refresh', async () => {
  const f = setup()
  let resolve!: (value: Awaited<ReturnType<typeof f.analyze>>) => void
  f.analyze.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const pending = f.coordinator.scan(f.owner, f.host, f.request)
  await vi.waitFor(() => expect(f.analyze).toHaveBeenCalled())
  const rejected = expect(pending).rejects.toThrow(/cancel/i)
  const fresh = await f.coordinator.scan(f.owner, f.host, f.request)
  resolve(fresh.analysis)
  await rejected
  expect(fresh.id).toBeTruthy()
  f.coordinator.close(f.owner, { root, reviewId: 'tab-1' })
  await expect(
    f.coordinator.evidence(f.owner, f.host, {
      root,
      reviewId: 'tab-1',
      snapshotId: fresh.id,
      path: localPath('/repo/a.ts'),
    }),
  ).rejects.toThrow()
})
it('previews pinned evidence and consumes launch authority once without changing bytes', async () => {
  const f = setup()
  const result = await f.coordinator.scan(f.owner, f.host, f.request)
  const request = { ...f.request, snapshotId: result.id, path: localPath('/repo/a.ts') }
  const preview = await f.coordinator.prepare(f.owner, f.host, request)
  await expect(
    f.coordinator.launchPayload(f.owner, f.host, { ...request, digest: 'wrong' }),
  ).rejects.toThrow(/preview/)
  expect(await f.coordinator.launchPayload(f.owner, f.host, preview)).toBe(preview.body)
  await expect(f.coordinator.launchPayload(f.owner, f.host, preview)).rejects.toThrow(
    /already/,
  )
})
it('refuses stale prepared launches and revokes preview authority with the workspace', async () => {
  const f = setup()
  const result = await f.coordinator.scan(f.owner, f.host, f.request)
  const preview = await f.coordinator.prepare(f.owner, f.host, {
    ...f.request,
    snapshotId: result.id,
    path: localPath('/repo/a.ts'),
  })
  f.liveState.mockResolvedValue('edited')
  await expect(f.coordinator.launchPayload(f.owner, f.host, preview)).rejects.toThrow(
    /stale/,
  )
  await f.resources.revokeWorkspace(root)
  await expect(f.coordinator.launchPayload(f.owner, f.host, preview)).rejects.toThrow(
    /unavailable/,
  )
})
it('concurrent launch attempts cannot consume one snapshot twice', async () => {
  const f = setup()
  const result = await f.coordinator.scan(f.owner, f.host, f.request)
  const preview = await f.coordinator.prepare(f.owner, f.host, {
    ...f.request,
    snapshotId: result.id,
    path: localPath('/repo/a.ts'),
  })
  const results = await Promise.allSettled([
    f.coordinator.launchPayload(f.owner, f.host, preview),
    f.coordinator.launchPayload(f.owner, f.host, preview),
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
})
it('releases workspace ownership when connection subscription setup fails', async () => {
  const f = setup()
  const register = vi.spyOn(f.resources, 'register')
  const broken = {
    ...f.host,
    onConnectionState: () => {
      throw new Error('subscription failed')
    },
  } as ProjectHost
  for (let i = 0; i < 6; i++) {
    await expect(
      f.coordinator.scan(f.owner, broken, { ...f.request, reviewId: `failed-${i}` }),
    ).rejects.toThrow('subscription failed')
  }
  // A later workspace revocation must not call disposal for failed scan leases.
  const close = vi.spyOn(f.coordinator, 'close')
  await f.resources.revokeWorkspace(root)
  expect(close).not.toHaveBeenCalled()
  expect(register).toHaveBeenCalledTimes(6)
})

it('returns unchecked pinned evidence without a host read, but cannot skip launch validation', async () => {
  const f = setup()
  const result = await f.coordinator.scan(f.owner, f.host, f.request)
  const request = {
    ...f.request,
    snapshotId: result.id,
    path: localPath('/repo/a.ts'),
    capturedOnly: true,
  }
  f.liveState.mockRejectedValue(new Error('host unavailable'))
  const evidence = await f.coordinator.evidence(f.owner, f.host, request)
  expect(evidence.stale).toBeNull()
  expect(evidence.diff.baseInput.content).toBe('before')
  expect(f.liveState).toHaveBeenCalledTimes(1)
  await expect(f.coordinator.prepare(f.owner, f.host, request)).rejects.toThrow(
    'host unavailable',
  )
})

it('shares one scan recorder with capture and analysis and reports the renderer payload', async () => {
  const f = setup(
    vi.fn<typeof captureArchitecture>((_host, _request, _signal, recorder) => {
      recorder?.measureSync(
        'hashing',
        () => 'digest',
        () => ({ bytes: 10, items: 1 }),
      )
      return Promise.resolve(snapshot)
    }),
  )
  const result = await f.coordinator.scan(f.owner, f.host, f.request)
  expect(f.analyze.mock.calls[0]?.[2]).toBe(f.capture.mock.calls[0]?.[3])
  expectMonotoneMetrics(result.metrics)
  expect(stagesOf(result.metrics)).toEqual(['hashing', 'renderer-payload'])
  const { metrics: _metrics, ...payload } = result
  expect(result.metrics.spans.at(-1)).toMatchObject({
    stage: 'renderer-payload',
    bytes: Buffer.byteLength(JSON.stringify(payload)),
  })
})
