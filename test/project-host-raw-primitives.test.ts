import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { LocalHost } from '../src/main/project-host/local-host'
import { hostPath, LOCAL_HOST_ID } from '../src/shared'

describe('LocalHost raw project primitives', () => {
  it('passes raw stdin bytes through buffered exec', async () => {
    const host = new LocalHost()
    const input = Buffer.from([0xff, 0x00, 0x61, 0xfe])
    const result = await host.exec(
      process.execPath,
      ['-e', 'process.stdin.on("data", chunk => process.stdout.write(chunk.toString("base64")))'],
      { input },
    )

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(input.toString('base64'))
  })

  it('reads symlink target bytes without dereferencing the target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-project-host-'))
    const link = join(root, 'link')
    const target = join(root, '..', 'outside-hvir-target')
    try {
      await symlink(target, link)
      const host = new LocalHost()

      await expect(host.readlink(hostPath(LOCAL_HOST_ID, link))).resolves.toEqual(
        Buffer.from(target),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
