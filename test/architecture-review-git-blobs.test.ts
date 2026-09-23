import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { GitCommandContext } from '../src/main/git/git-command-context'
import { readArchitectureBlobs } from '../src/main/architecture-review/git-blobs'
import { localPath } from '../src/shared/host-path'

function objectId(content: Uint8Array): string {
  return createHash('sha1')
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex')
}

function batchRecord(id: string, content: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from(`${id} blob ${content.byteLength}\n`, 'ascii'),
    Buffer.from(content),
    Buffer.from('\n', 'ascii'),
  ])
}

function contextFor(output: string) {
  const readOnly = vi.fn().mockResolvedValue({
    code: 0,
    signal: null,
    stdout: output,
    stderr: '',
  })
  return {
    context: { readOnly } as unknown as GitCommandContext,
    readOnly,
  }
}

describe('architecture historical blob reads', () => {
  it('preserves valid multibyte UTF-8 and batches objects in one Git request', async () => {
    const first = Buffer.from('export const greeting = "こんにちは 🌍"\n', 'utf8')
    const second = Buffer.from('export const value = "café"\n', 'utf8')
    const firstId = objectId(first)
    const secondId = objectId(second)
    const { context, readOnly } = contextFor(
      Buffer.concat([
        batchRecord(firstId, first),
        batchRecord(secondId, second),
      ]).toString('utf8'),
    )

    const result = await readArchitectureBlobs(context, localPath('/workspace'), [
      firstId,
      secondId,
    ])

    expect(result.get(firstId)).toBe(first.toString('utf8'))
    expect(result.get(secondId)).toBe(second.toString('utf8'))
    expect(readOnly).toHaveBeenCalledOnce()
    expect(readOnly.mock.calls[0]?.[1]).toEqual(['cat-file', '--batch'])
    const options = readOnly.mock.calls[0]?.[2] as { readonly input?: string } | undefined
    expect(options?.input).toBe(`${firstId}\n${secondId}\n`)
  })

  it('rejects historical objects whose transport decoding changes invalid UTF-8 bytes', async () => {
    const invalid = Buffer.from([0x65, 0x78, 0xff, 0xfe, 0x0a])
    const id = objectId(invalid)
    const { context } = contextFor(batchRecord(id, invalid).toString('utf8'))

    await expect(
      readArchitectureBlobs(context, localPath('/workspace'), [id]),
    ).rejects.toThrow(/invalid UTF-8|changed architecture source object/i)
  })
})
