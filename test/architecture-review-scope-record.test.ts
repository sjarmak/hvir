import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { joinHostPath, localPath } from '../src/shared/host-path'
import { ARCHITECTURE_LAYOUT_FILE } from '../src/shared/architecture-layout'
import {
  layoutWithScope,
  recordArchitectureScope,
} from '../src/main/architecture-review/scope-record'
import { captureArchitecture } from '../src/main/architecture-review/capture'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'hvir-architecture-scope-record-'))
  roots.push(root)
  const file = joinHostPath(localPath(root), ARCHITECTURE_LAYOUT_FILE)
  const record = (scope: readonly string[]) =>
    recordArchitectureScope(new LocalHost(), file, scope)
  const layoutText = () => readFile(join(root, ARCHITECTURE_LAYOUT_FILE), 'utf8')
  return { root, record, layoutText }
}

it('creates the layout file with the chosen scope when none exists', async () => {
  const w = await workspace()
  await expect(w.record(['src/web', 'src/api'])).resolves.toEqual({
    scope: ['src/web', 'src/api'],
    written: true,
  })
  expect(JSON.parse(await w.layoutText())).toEqual({
    version: 1,
    scope: ['src/web', 'src/api'],
  })
})

it('writes nothing when the whole repository is chosen and no file exists', async () => {
  const w = await workspace()
  await expect(w.record([])).resolves.toEqual({ scope: [], written: false })
  await expect(stat(join(w.root, '.hvir'))).rejects.toThrow()
})

it('replaces only the scope and keeps the subsystem mapping as written', async () => {
  const w = await workspace()
  await mkdir(join(w.root, '.hvir'))
  const subsystems = [{ name: 'ui', paths: ['src/renderer'] }]
  await writeFile(
    join(w.root, ARCHITECTURE_LAYOUT_FILE),
    JSON.stringify({ subsystems, version: 1, scope: ['old'], sourceRoots: ['lib'] }),
  )
  await w.record(['src'])
  expect(JSON.parse(await w.layoutText())).toEqual({
    version: 1,
    scope: ['src'],
    subsystems,
    sourceRoots: ['lib'],
  })
  await w.record([])
  expect(JSON.parse(await w.layoutText())).toEqual({
    version: 1,
    subsystems,
    sourceRoots: ['lib'],
  })
})

it('refuses an invalid scope or an invalid existing file and leaves the file alone', async () => {
  const w = await workspace()
  await expect(w.record(['../outside'])).rejects.toThrow(
    /"scope\[0\]" must be a relative path/,
  )
  await expect(w.record(['src', 'src'])).rejects.toThrow(/repeats "src"/)
  await mkdir(join(w.root, '.hvir'))
  await writeFile(join(w.root, ARCHITECTURE_LAYOUT_FILE), '{"version":2}')
  await expect(w.record(['src'])).rejects.toThrow(
    'Invalid .hvir/architecture.json in the working tree: "version" must be 1',
  )
  expect(await w.layoutText()).toBe('{"version":2}')
})

it('formats the recorded file as stable, readable JSON', () => {
  expect(layoutWithScope(undefined, ['src'])).toBe(
    '{\n  "version": 1,\n  "scope": [\n    "src"\n  ]\n}\n',
  )
})

it('narrows the next live scan to the recorded scope', async () => {
  const w = await workspace()
  const git = (...args: string[]) => execFileSync('git', ['-C', w.root, ...args])
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.test')
  git('config', 'user.name', 'Test')
  await mkdir(join(w.root, 'src/web'), { recursive: true })
  await mkdir(join(w.root, 'src/api'), { recursive: true })
  await writeFile(join(w.root, 'src/web/a.ts'), 'export const a = 1\n')
  await writeFile(join(w.root, 'src/api/b.ts'), 'export const b = 1\n')
  git('add', '.')
  git('commit', '-m', 'baseline')
  await w.record(['src/web'])
  const capture = await captureArchitecture(
    new LocalHost(),
    { root: localPath(w.root), baseline: 'HEAD' },
    new AbortController().signal,
  )
  expect(capture.after.map((file) => file.path)).toEqual(['src/web/a.ts'])
  expect(capture.layout.scope).toEqual(['src/web'])
})
