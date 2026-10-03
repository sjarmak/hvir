import { describe, expect, it } from 'vitest'
import * as hegel from '@hegeldev/hegel'
import * as gs from '@hegeldev/hegel/generators'

import {
  CHECKPOINT_MAX_PATH_BYTES,
  compareCheckpointEntries,
  encodeCheckpointTree,
  parseCheckpointTree,
} from '../src/main/git/review-checkpoint-model'

const OID = '0123456789abcdef0123456789abcdef01234567'
const OID64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('review checkpoint model', () => {
  it('round trips legal tree records with tabs, newlines, and backslashes', () => {
    const output = [
      `100644 blob ${OID}\tREADME\tlocal\\name\nnext\0`,
      `120000 blob ${OID}\tlink\0`,
    ].join('')

    expect(parseCheckpointTree(output)).toEqual([
      { relativePath: 'README\tlocal\\name\nnext', mode: '100644', oid: OID },
      { relativePath: 'link', mode: '120000', oid: OID },
    ])
  })

  it('rejects incomplete, duplicate, unsafe, unsupported, and mixed trees', () => {
    expect(() => parseCheckpointTree(`100644 blob ${OID}\tfile`)).toThrow()
    expect(() =>
      parseCheckpointTree(
        [`100644 blob ${OID}\tfile`, `100644 blob ${OID}\tfile`].join('\0') + '\0',
      ),
    ).toThrow()
    expect(() => parseCheckpointTree(`100644 blob ${OID}\t../file\0`)).toThrow()
    expect(() => parseCheckpointTree(`160000 commit ${OID}\tmodule\0`)).toThrow()
    expect(() =>
      parseCheckpointTree(
        [`100644 blob ${OID}\tfile`, `100644 blob ${OID64}\tother`].join('\0') + '\0',
      ),
    ).toThrow()
    expect(() => parseCheckpointTree(`100644 blob ${OID}\t.git/config\0`)).toThrow()
  })

  it('compares exact mode and object identity in stable path order', () => {
    expect(
      compareCheckpointEntries(
        [
          { relativePath: 'same', mode: '100644', oid: OID },
          { relativePath: 'removed', mode: '100644', oid: OID },
          { relativePath: 'mode', mode: '100644', oid: OID },
        ],
        [
          { relativePath: 'same', mode: '100644', oid: OID },
          { relativePath: 'added', mode: '100755', oid: OID },
          { relativePath: 'mode', mode: '100755', oid: OID },
        ],
      ),
    ).toEqual([
      {
        relativePath: 'added',
        after: { relativePath: 'added', mode: '100755', oid: OID },
      },
      {
        relativePath: 'mode',
        before: { relativePath: 'mode', mode: '100644', oid: OID },
        after: { relativePath: 'mode', mode: '100755', oid: OID },
      },
      {
        relativePath: 'removed',
        before: { relativePath: 'removed', mode: '100644', oid: OID },
      },
    ])
  })

  it('encodes immediate files and trees for mktree without shell quoting', () => {
    expect(
      encodeCheckpointTree([
        { name: 'dir', mode: '040000', oid: OID },
        { name: 'file\tname', mode: '100644', oid: OID },
      ]),
    ).toBe(
      [`040000 tree ${OID}\tdir`, `100644 blob ${OID}\tfile\tname`].join('\0') + '\0',
    )
  })

  it('rejects invalid encoder names and object identities', () => {
    expect(() => encodeCheckpointTree([{ name: 'a/b', mode: '100644', oid: OID }])).toThrow()
    expect(() => encodeCheckpointTree([{ name: '.git', mode: '100644', oid: OID }])).toThrow()
    expect(() => encodeCheckpointTree([{ name: 'file', mode: '100644', oid: 'bad' }])).toThrow()
    expect(() =>
      encodeCheckpointTree([
        { name: 'file', mode: '100644', oid: OID },
        { name: 'other', mode: '100644', oid: OID64 },
      ]),
    ).toThrow()
  })

  it('round trip preserves every generated legal filename', () => {
    return hegel.test((tc) => {
      const values = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 20 })))
      const entries = [...new Set(values)].map((value) => ({
        name: `file-${value}`,
        mode: '100644' as const,
        oid: OID,
      }))
      const parsed = parseCheckpointTree(encodeCheckpointTree(entries))
      expect(parsed).toEqual(
        entries
          .map(({ name, mode, oid }) => ({ relativePath: name, mode, oid }))
          .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      )
    })
  })

  it('enforces the path byte limit', () => {
    expect(() => parseCheckpointTree(`100644 blob ${OID}\t${'a'.repeat(CHECKPOINT_MAX_PATH_BYTES + 1)}\0`)).toThrow()
  })

  it('rejects unpaired surrogate path text', () => {
    expect(() => parseCheckpointTree(`100644 blob ${OID}\t\ud800\0`)).toThrow()
    expect(() => parseCheckpointTree(`100644 blob ${OID}\tfile\ud800\0`)).toThrow()
  })
})
