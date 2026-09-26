import { expect, it, vi } from 'vitest'
import { ArchitectureReviewCoordinator } from '../src/main/architecture-review/coordinator'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { localPath, hostPath, asHostId } from '../src/shared/host-path'
import type { ProjectHost } from '../src/main/project-host'
import type { ArchitectureCapture } from '../src/shared/architecture-review'
import { ARCHITECTURE_DEFAULT_LAYOUT } from '../src/shared/architecture-layout'
import type { ArchitectureAnalysis } from '../src/shared/architecture-analysis'
import type { ArchitectureScanRecorder } from '../src/main/architecture-review/scan-recorder'
import type { captureArchitecture } from '../src/main/architecture-review/capture'
import type {
  readArchitectureLiveBase,
  readArchitectureLiveState,
} from '../src/main/architecture-review/freshness'
import type { writeArchitectureBrief } from '../src/main/architecture-review/handoff'
import type { HostPath } from '../src/shared/host-path'
import type { AddedWorktree } from '../src/main/git/mutation-coordinator'
import { expectMonotoneMetrics, stagesOf } from './architecture-scan-metrics-fixture'
import { gitBlobId } from '../src/main/architecture-review/blob-id'

const source = (path: string, content: string) => ({
  path,
  content,
  object: gitBlobId(Buffer.from(content)),
})
const root = localPath('/repo')
const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const WORKTREE = '/repo.hvir-worktrees'
const snapshot: ArchitectureCapture = {
  root,
  baselineRef: 'HEAD',
  currentRef: 'working tree',
  baselineRevision: BASE,
  currentRevision: 'working-tree',
  fingerprint: 'fingerprint',
  before: [source('a.ts', 'before')],
  after: [],
  configs: { before: [], after: [] },
  exclusions: [],
  layout: ARCHITECTURE_DEFAULT_LAYOUT,
  capturedAt: 'now',
}
function setup(
  capture = vi.fn<typeof captureArchitecture>(() => Promise.resolve(snapshot)),
) {
  const resources = new RendererResourceScopes()
  const owner = resources.activateOwner(1)
  let watchEvent: (() => void) | undefined
  const stopWatch = vi.fn<() => void>()
  const watch = vi.fn<ProjectHost['watch']>((_path, onEvent) => {
    watchEvent = () => onEvent({ type: 'change', path: root })
    return stopWatch
  })
  const host = {
    hostId: root.hostId,
    connectionState: 'connected',
    onConnectionState: () => () => undefined,
    watch,
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
  const liveBase = vi.fn<typeof readArchitectureLiveBase>(() =>
    Promise.resolve({ head: HEAD, prefix: '', clean: true }),
  )
  const worktreeTarget = vi.fn((_root: HostPath, slug: string, commit: string) => ({
    branch: `hvir/architecture/${slug}`,
    path: `${WORKTREE}/${slug}`,
    commit,
  }))
  // Worktrees main holds as in-flight handoffs: removal refuses them until released.
  const held = new Set<string>()
  const hold = (added: AddedWorktree) => {
    held.add(added.root.path)
    return {
      added,
      release: () => {
        held.delete(added.root.path)
      },
    }
  }
  const addWorktree = vi.fn((_root: HostPath, slug: string) =>
    Promise.resolve(
      hold({
        projectId: 'project-1',
        workspaceId: `workspace-${slug}`,
        root: localPath(`${WORKTREE}/${slug}`),
        branch: `hvir/architecture/${slug}`,
      }),
    ),
  )
  const holdWorktree = vi.fn((added: AddedWorktree) => Promise.resolve(hold(added)))
  const writeBrief = vi.fn<typeof writeArchitectureBrief>(() => Promise.resolve())
  const coordinator = new ArchitectureReviewCoordinator({
    resources,
    capture,
    liveState,
    analyze,
    handoff: {
      worktrees: { worktreeTarget, addWorktree, holdWorktree },
      liveBase,
      writeBrief,
    },
  })
  return {
    held,
    holdWorktree,
    liveBase,
    addWorktree,
    writeBrief,
    liveState,
    resources,
    owner,
    host,
    coordinator,
    capture,
    analyze,
    watch,
    stopWatch,
    emitWatch: () => watchEvent?.(),
    request: { root, baseline: 'HEAD', reviewId: 'tab-1' },
  }
}

it('publishes one live refresh after writes settle and stops immediately when paused', async () => {
  vi.useFakeTimers()
  try {
    const f = setup()
    const publish = vi.fn()
    await f.coordinator.scan(f.owner, f.host, f.request)
    f.coordinator.follow(f.owner, f.host, f.request, publish)
    expect(f.watch).toHaveBeenCalledWith(
      root,
      expect.any(Function),
      expect.objectContaining({ recursive: true }),
    )
    f.emitWatch()
    await vi.advanceTimersByTimeAsync(1_500)
    f.emitWatch()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(publish).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(publish).toHaveBeenCalledOnce()
    f.coordinator.pause(f.owner, f.request)
    expect(f.stopWatch).toHaveBeenCalledOnce()
    f.emitWatch()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(publish).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it('keeps the live watch across replacement snapshots and releases it on close', async () => {
  const f = setup()
  await f.coordinator.scan(f.owner, f.host, f.request)
  f.coordinator.follow(f.owner, f.host, f.request, vi.fn())
  await f.coordinator.scan(f.owner, f.host, f.request)
  expect(f.stopWatch).not.toHaveBeenCalled()
  expect(f.watch).toHaveBeenCalledOnce()
  f.coordinator.close(f.owner, f.request)
  expect(f.stopWatch).toHaveBeenCalledOnce()
})
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
  expect(evidence.diff).toMatchObject({
    base: 'working-tree',
    baseLabel: `HEAD (${BASE.slice(0, 12)})`,
    currentLabel: 'working tree',
  })
  expect(evidence.diff.revision).toBeUndefined()
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
async function prepared(f: ReturnType<typeof setup>) {
  const result = await f.coordinator.scan(f.owner, f.host, f.request)
  const request = { ...f.request, snapshotId: result.id, path: localPath('/repo/a.ts') }
  return { request, preview: await f.coordinator.prepare(f.owner, f.host, request) }
}
it('previews the exact worktree, brief and prompt, then hands off and launches once', async () => {
  const f = setup()
  const { request, preview } = await prepared(f)
  expect(preview.handoff.commit).toBe(HEAD)
  expect(preview.handoff.branch).toMatch(/^hvir\/architecture\/review-[0-9a-f]{8}$/)
  expect(preview.handoff.brief).toContain(`"currentRevision":"${HEAD}"`)
  expect(preview.body).toContain('.hvir-architecture-brief.md')
  expect(f.addWorktree).not.toHaveBeenCalled()
  await expect(
    f.coordinator.handoff(f.owner, f.host, { ...request, digest: 'wrong' }),
  ).rejects.toThrow(/preview/)
  const handoff = await f.coordinator.handoff(f.owner, f.host, preview)
  expect(handoff.worktree).toEqual(preview.handoff.worktree)
  expect(f.writeBrief).toHaveBeenCalledWith(
    f.host,
    preview.handoff.worktree,
    preview.handoff.brief,
    expect.any(AbortSignal),
  )
  await expect(f.coordinator.handoff(f.owner, f.host, preview)).rejects.toThrow(/preview/)
  expect(f.addWorktree).toHaveBeenCalledOnce()
  expect(() =>
    f.coordinator.launchPayload(f.owner, f.host, { ...handoff.launch, digest: 'x' }),
  ).toThrow(/unavailable/)
  expect(f.coordinator.launchPayload(f.owner, f.host, handoff.launch)).toBe(preview.body)
  f.coordinator.assertLaunchCurrent(f.owner, f.host, handoff.launch)
  expect(() => f.coordinator.launchPayload(f.owner, f.host, handoff.launch)).toThrow(
    /already used/,
  )
})
it('refuses a stale, dirty or subdirectory handoff before creating a worktree', async () => {
  const f = setup()
  const { preview } = await prepared(f)
  f.liveBase.mockResolvedValueOnce({ head: HEAD, prefix: '', clean: false })
  await expect(f.coordinator.handoff(f.owner, f.host, preview)).rejects.toThrow(/Commit/)
  f.liveBase.mockResolvedValueOnce({ head: 'c'.repeat(40), prefix: '', clean: true })
  await expect(f.coordinator.handoff(f.owner, f.host, preview)).rejects.toThrow(/preview/)
  f.liveBase.mockResolvedValueOnce({ head: HEAD, prefix: 'src/', clean: true })
  await expect(f.coordinator.handoff(f.owner, f.host, preview)).rejects.toThrow(/root/)
  f.liveState.mockResolvedValue('edited')
  await expect(f.coordinator.handoff(f.owner, f.host, preview)).rejects.toThrow(/stale/)
  await f.resources.revokeWorkspace(root)
  await expect(f.coordinator.handoff(f.owner, f.host, preview)).rejects.toThrow(/preview/)
  expect(f.addWorktree).not.toHaveBeenCalled()
})
it('starts a commit-pair handoff at the Current commit, dirty tree or not', async () => {
  const pair = { ...snapshot, currentRef: 'v2', currentRevision: 'd'.repeat(40) }
  const f = setup(vi.fn<typeof captureArchitecture>(() => Promise.resolve(pair)))
  f.liveBase.mockResolvedValue({ head: HEAD, prefix: '', clean: false })
  const { preview } = await prepared(f)
  expect(preview.handoff.commit).toBe('d'.repeat(40))
  await f.coordinator.handoff(f.owner, f.host, preview)
  expect(f.addWorktree).toHaveBeenCalledWith(root, expect.any(String), 'd'.repeat(40))
})
it('concurrent handoffs cannot create two worktrees from one preview', async () => {
  const f = setup()
  const { preview } = await prepared(f)
  const results = await Promise.allSettled([
    f.coordinator.handoff(f.owner, f.host, preview),
    f.coordinator.handoff(f.owner, f.host, preview),
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(f.addWorktree).toHaveBeenCalledOnce()
})
it('refuses a launch for another renderer or host', async () => {
  const f = setup()
  const { preview } = await prepared(f)
  const { launch } = await f.coordinator.handoff(f.owner, f.host, preview)
  const other: ProjectHost = { ...f.host }
  expect(() => f.coordinator.launchPayload(f.owner, other, launch)).toThrow(/unavailable/)
  expect(() => f.coordinator.assertLaunchCurrent(f.owner, f.host, launch)).toThrow(
    /cancelled/,
  )
  await f.resources.revokeOwner(f.owner.id)
  expect(() => f.coordinator.launchPayload(f.owner, f.host, launch)).toThrow(/revoked/)
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

it('keys commit-pair evidence to its Current commit and never checks freshness', async () => {
  const pair = { ...snapshot, currentRef: 'v2', currentRevision: 'def' }
  const f = setup(vi.fn<typeof captureArchitecture>(() => Promise.resolve(pair)))
  const request = { ...f.request, current: 'v2' }
  const result = await f.coordinator.scan(f.owner, f.host, request)
  const evidence = await f.coordinator.evidence(f.owner, f.host, {
    root,
    reviewId: 'tab-1',
    snapshotId: result.id,
    path: localPath('/repo/a.ts'),
  })
  expect(evidence.diff).toMatchObject({
    base: 'head',
    revision: 'def',
    baseLabel: `HEAD (${BASE.slice(0, 12)})`,
    currentLabel: 'v2 (def)',
  })
  expect(evidence.stale).toBe(false)
  expect(f.liveState).not.toHaveBeenCalled()
  expect(result).toMatchObject({ baselineRef: 'HEAD', currentRef: 'v2' })
})

it('lists the commit strip for the current renderer only', async () => {
  const f = setup()
  const range = {
    base: { revision: 'a', parent: null, subject: 's' },
    commits: [],
    truncated: false,
  }
  const commits = vi.fn(() => Promise.resolve(range))
  const coordinator = new ArchitectureReviewCoordinator({
    resources: f.resources,
    commits,
    analyze: f.analyze,
  })
  await expect(coordinator.commits(f.owner, f.host, { root, from: 'v1' })).resolves.toBe(
    range,
  )
  expect(commits).toHaveBeenCalledWith(
    f.host,
    { root, from: 'v1' },
    expect.any(AbortSignal),
  )
  await f.resources.revokeOwner(f.owner.id)
  await expect(coordinator.commits(f.owner, f.host, { root })).rejects.toThrow(/revoked/)
  expect(commits).toHaveBeenCalledOnce()
})
it('finishes an interrupted handoff in the worktree it already created', async () => {
  const f = setup()
  const { preview } = await prepared(f)
  f.writeBrief.mockRejectedValueOnce(new Error('host disconnected'))
  const path = preview.handoff.worktree.path
  await expect(f.coordinator.handoff(f.owner, f.host, preview)).rejects.toThrow(
    new RegExp(`${path} was created.*host disconnected`),
  )
  const again = await f.coordinator.prepare(f.owner, f.host, preview)
  expect(again.digest).toBe(preview.digest)
  expect(again.handoff.worktree).toEqual(preview.handoff.worktree)
  const handoff = await f.coordinator.handoff(f.owner, f.host, again)
  expect(handoff.worktree).toEqual(preview.handoff.worktree)
  expect(f.addWorktree).toHaveBeenCalledOnce()
  expect(f.writeBrief).toHaveBeenCalledTimes(2)
  expect(f.coordinator.launchPayload(f.owner, f.host, handoff.launch)).toBe(preview.body)
  const next = await f.coordinator.prepare(f.owner, f.host, preview)
  expect(next.digest).not.toBe(preview.digest)
})
it('does not rewrite a brief that landed before the handoff was interrupted', async () => {
  const f = setup()
  const { preview } = await prepared(f)
  let briefs = 0
  f.writeBrief.mockImplementation(() => {
    briefs++
    return Promise.resolve()
  })
  const assertCurrent = f.resources.assertCurrent.bind(f.resources)
  let interrupted = false
  vi.spyOn(f.resources, 'assertCurrent').mockImplementation((owner) => {
    if (briefs === 1 && !interrupted) {
      interrupted = true
      throw new Error('renderer moved')
    }
    assertCurrent(owner)
  })
  await expect(f.coordinator.handoff(f.owner, f.host, preview)).rejects.toThrow(
    /renderer moved/,
  )
  const again = await f.coordinator.prepare(f.owner, f.host, preview)
  await f.coordinator.handoff(f.owner, f.host, again)
  expect(f.addWorktree).toHaveBeenCalledOnce()
  expect(briefs).toBe(1)
})
it('holds the handoff worktree in flight from creation until its brief write settles', async () => {
  const f = setup()
  const { preview } = await prepared(f)
  const path = preview.handoff.worktree.path
  const during: boolean[] = []
  f.writeBrief.mockImplementationOnce(() => {
    during.push(f.held.has(path))
    return Promise.reject(new Error('host disconnected'))
  })
  await expect(f.coordinator.handoff(f.owner, f.host, preview)).rejects.toThrow(
    /host disconnected/,
  )
  expect(f.held.has(path)).toBe(false)

  f.writeBrief.mockImplementationOnce(() => {
    during.push(f.held.has(path))
    return Promise.resolve()
  })
  const again = await f.coordinator.prepare(f.owner, f.host, preview)
  await f.coordinator.handoff(f.owner, f.host, again)
  expect(during).toEqual([true, true])
  expect(f.holdWorktree).toHaveBeenCalledOnce()
  expect(f.held.has(path)).toBe(false)
})
