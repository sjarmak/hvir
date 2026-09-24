import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  linkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TarFramingError,
  readTarEntries,
} from '../src/main/architecture-review/tar-archive'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hvir-tar-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

function archive(root: string, paths: readonly string[], ...flags: string[]): Buffer {
  return execFileSync('tar', ['-cf', '-', ...flags, '--', ...paths], { cwd: root })
}

const longPath = `${'deep/'.repeat(30)}module.ts`

describe('architecture live-read archive parsing', () => {
  it.each([['gnu'], ['posix'], ['ustar']])(
    'reads names, types and exact bytes from a %s archive',
    (format) => {
      const files = {
        'src/a.ts': 'export const a = "café 🌍"\n',
        'src/empty.ts': '',
        ...(format === 'ustar' ? {} : { [longPath]: 'export {}\n' }),
      }
      const root = tree(files)
      const entries = readTarEntries(
        archive(root, Object.keys(files), `--format=${format}`),
      )
      expect(entries.map((entry) => [entry.name, entry.type])).toEqual(
        Object.keys(files).map((path) => [path, 'file']),
      )
      expect(entries.map((entry) => entry.content.toString('utf8'))).toEqual(
        Object.values(files),
      )
    },
  )

  it('reads concatenated archives, as xargs produces when it splits the list', () => {
    const root = tree({ 'a.ts': 'a', 'b.ts': 'b' })
    const joined = Buffer.concat([archive(root, ['a.ts']), archive(root, ['b.ts'])])
    expect(readTarEntries(joined).map((entry) => entry.name)).toEqual(['a.ts', 'b.ts'])
  })

  it('reports symbolic links and resolves hard links to the bytes they share', () => {
    const root = tree({ 'a.ts': 'shared' })
    symlinkSync('/etc/passwd', join(root, 'link.ts'))
    linkSync(join(root, 'a.ts'), join(root, 'hard.ts'))
    const entries = readTarEntries(archive(root, ['a.ts', 'link.ts', 'hard.ts']))
    expect(entries.map((entry) => [entry.name, entry.type])).toEqual([
      ['a.ts', 'file'],
      ['link.ts', 'symlink'],
      ['hard.ts', 'file'],
    ])
    expect(entries[2]?.content.toString('utf8')).toBe('shared')
  })

  it('refuses a stream whose framing was damaged, naming how many entries were whole', () => {
    const root = tree({ 'a.ts': 'x'.repeat(10), 'b.ts': 'b' })
    const bytes = archive(root, ['a.ts', 'b.ts'])
    // One more content byte than the header declares shifts every later header.
    const damaged = Buffer.concat([
      bytes.subarray(0, 512),
      Buffer.from('y'),
      bytes.subarray(512),
    ])
    const error = (() => {
      try {
        readTarEntries(damaged)
      } catch (caught) {
        return caught
      }
      return undefined
    })()
    expect(error).toBeInstanceOf(TarFramingError)
    expect((error as TarFramingError).complete).toBe(1)
  })

  it('refuses a truncated stream', () => {
    const root = tree({ 'a.ts': 'x'.repeat(600) })
    expect(() => readTarEntries(archive(root, ['a.ts']).subarray(0, 700))).toThrow(
      TarFramingError,
    )
  })
})
