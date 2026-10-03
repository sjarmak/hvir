import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  CHECKPOINT_MAX_FILE_BYTES,
  readCheckpointFile,
} from '../src/main/git/review-checkpoint-file'
import { LocalHost } from '../src/main/project-host/local-host'
import { hostPath, LOCAL_HOST_ID } from '../src/shared'

describe('readCheckpointFile', () => {
  it('reads regular and executable files with bounded raw chunks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-checkpoint-file-'))
    try {
      await writeFile(join(root, 'regular'), Buffer.from([0xff, 0x00, 0x61]))
      await writeFile(join(root, 'executable'), 'run')
      await chmod(join(root, 'executable'), 0o755)
      const host = new LocalHost()
      const signal = new AbortController().signal
      const rootPath = hostPath(LOCAL_HOST_ID, root)

      await expect(
        readCheckpointFile(host, rootPath, 'regular', signal),
      ).resolves.toEqual({
        mode: '100644',
        bytes: Buffer.from([0xff, 0x00, 0x61]),
      })
      await expect(
        readCheckpointFile(host, rootPath, 'executable', signal),
      ).resolves.toEqual({
        mode: '100755',
        bytes: Buffer.from('run'),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads symlink target bytes without following an outside target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-checkpoint-file-'))
    try {
      const target = join(root, '..', 'checkpoint-outside-target')
      await symlink(target, join(root, 'link'))
      const host = new LocalHost()

      await expect(
        readCheckpointFile(
          host,
          hostPath(LOCAL_HOST_ID, root),
          'link',
          new AbortController().signal,
        ),
      ).resolves.toEqual({ mode: '120000', bytes: Buffer.from(target) })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns null only when the requested final file is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-checkpoint-file-'))
    try {
      const host = new LocalHost()
      await expect(
        readCheckpointFile(
          host,
          hostPath(LOCAL_HOST_ID, root),
          'missing',
          new AbortController().signal,
        ),
      ).resolves.toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects invalid paths, wrong hosts, directories, and cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-checkpoint-file-'))
    try {
      const host = new LocalHost()
      const rootPath = hostPath(LOCAL_HOST_ID, root)
      await expect(
        readCheckpointFile(host, rootPath, '../escape', new AbortController().signal),
      ).rejects.toThrow()
      await expect(
        readCheckpointFile(
          host,
          hostPath('ssh:test' as typeof LOCAL_HOST_ID, root),
          'file',
          new AbortController().signal,
        ),
      ).rejects.toThrow()
      await expect(
        readCheckpointFile(host, rootPath, '.', new AbortController().signal),
      ).rejects.toThrow()
      const controller = new AbortController()
      controller.abort()
      await expect(
        readCheckpointFile(host, rootPath, 'file', controller.signal),
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('bounds symlink bytes before requesting the host payload', async () => {
    const host = new LocalHost()
    const root = hostPath(LOCAL_HOST_ID, '/checkpoint-test')
    const stat = { size: 0, mtimeMs: 1, mode: 0o755, type: 'dir' as const }
    vi.spyOn(host, 'stat').mockImplementation((path) =>
      Promise.resolve(
        path.path === root.path
          ? stat
          : { ...stat, type: 'symlink', size: CHECKPOINT_MAX_FILE_BYTES + 1 },
      ),
    )
    vi.spyOn(host, 'realpath').mockImplementation((path) => Promise.resolve(path))
    const readlink = vi.spyOn(host, 'readlink')
    try {
      await expect(
        readCheckpointFile(host, root, 'link', new AbortController().signal),
      ).rejects.toThrow('size limit')
      expect(readlink).not.toHaveBeenCalled()
    } finally {
      await host.dispose()
    }
  })
})
