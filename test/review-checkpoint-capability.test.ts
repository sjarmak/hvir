import { describe, expect, it } from 'vitest'

import { ReviewCheckpointCapability } from '../src/main/git/review-checkpoint-capability'
import { hostPath, localPath } from '../src/shared'
import type { ReviewCheckpointHostRequest } from '../src/shared/review-checkpoint'

const root = localPath('/repo')
const OID = '0123456789abcdef0123456789abcdef01234567'
const OID2 = 'abcdef0123456789abcdef0123456789abcdef01'

describe('ReviewCheckpointCapability', () => {
  it('returns live changes against a saved baseline', async () => {
    const port = scriptedPort({
      inspect: { root, oid: OID, objectFormat: 'sha1' },
      tree: `100644 blob ${OID}\ta.txt\0`,
      files: 'a.txt\0new.txt\0',
      tracked: `H 100644 ${OID} 0\ta.txt\0`,
      hashes: {
        'a.txt': { mode: '100644', oid: OID2 },
        'new.txt': { mode: '100755', oid: OID },
      },
    })

    await expect(new ReviewCheckpointCapability(port, root).status()).resolves.toEqual({
      root,
      oid: OID,
      changes: [
        {
          path: hostPath(root.hostId, '/repo/a.txt'),
          before: { mode: '100644', oid: OID },
          after: { mode: '100644', oid: OID2 },
        },
        {
          path: hostPath(root.hostId, '/repo/new.txt'),
          before: null,
          after: { mode: '100755', oid: OID },
        },
      ],
    })
  })

  it('captures nested trees, verifies a second live enumeration, and updates once', async () => {
    const calls: ReviewCheckpointHostRequest[] = []
    const port = scriptedPort({
      calls,
      inspect: { root, oid: null, objectFormat: 'sha1' },
      files: 'a.txt\0dir/b.txt\0',
      tracked: `H 100644 ${OID} 0\ta.txt\0`,
      hashes: {
        'a.txt': { mode: '100644', oid: OID },
        'dir/b.txt': { mode: '100644', oid: OID2 },
      },
      treeOids: [OID2, OID],
    })

    await expect(
      new ReviewCheckpointCapability(port, root).capture(),
    ).resolves.toMatchObject({
      oid: OID,
      changes: [],
    })
    expect(calls.at(-1)).toEqual({ action: 'update-ref', oid: OID, previous: null })
  })

  it('clears only an existing checkpoint', async () => {
    const calls: ReviewCheckpointHostRequest[] = []
    const port = scriptedPort({
      calls,
      inspect: { root, oid: OID, objectFormat: 'sha1' },
    })
    await new ReviewCheckpointCapability(port, root).clear()
    expect(calls).toContainEqual({ action: 'clear-ref', previous: OID })
  })

  it.each(['status', 'diff'] as const)(
    'rejects a %s result when the baseline changes during reads',
    async (action) => {
      const delegate = scriptedPort({
        inspect: { root, oid: OID, objectFormat: 'sha1' },
        tree: `100644 blob ${OID}\ta.txt\0`,
        files: 'a.txt\0',
        hashes: { 'a.txt': { mode: '100644', oid: OID2 } },
      })
      let inspections = 0
      const capability = new ReviewCheckpointCapability(
        {
          call: (request) =>
            request.action === 'inspect' && ++inspections > 1
              ? Promise.resolve({ root, oid: null, objectFormat: 'sha1' })
              : delegate.call(request),
        },
        root,
      )
      const result =
        action === 'status'
          ? capability.status()
          : capability.diff(OID, {
              path: localPath('/repo/a.txt'),
              before: { mode: '100644', oid: OID },
              after: { mode: '100644', oid: OID2 },
            })
      await expect(result).rejects.toThrow('baseline changed')
    },
  )
})

function scriptedPort(options: {
  readonly calls?: ReviewCheckpointHostRequest[]
  readonly inspect: {
    readonly root: typeof root
    readonly oid: string | null
    readonly objectFormat: 'sha1'
  }
  readonly tree?: string
  readonly files?: string
  readonly tracked?: string
  readonly hashes?: Record<
    string,
    { readonly mode: '100644' | '100755' | '120000'; readonly oid: string }
  >
  readonly treeOids?: readonly string[]
}) {
  let treeIndex = 0
  return {
    async call(request: ReviewCheckpointHostRequest) {
      await Promise.resolve()
      options.calls?.push(request)
      switch (request.action) {
        case 'inspect':
          return options.inspect
        case 'tree':
          return options.tree ?? ''
        case 'files':
          return options.files ?? ''
        case 'tracked':
          return options.tracked ?? ''
        case 'hash':
          return options.hashes?.[request.relativePath] ?? null
        case 'write-tree':
          return options.treeOids?.[treeIndex++] ?? OID
        case 'update-ref':
          return ''
        case 'clear-ref':
          return ''
        case 'blob':
          return {
            content: '',
            complete: true,
            validUtf8: true,
            byteLength: 0,
            lineCount: 1,
          }
        case 'read-live':
          return {
            content: '',
            complete: true,
            validUtf8: true,
            byteLength: 0,
            lineCount: 1,
          }
      }
    },
  }
}
