import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath } from '../src/shared/host-path'
import { ARCHITECTURE_DEFAULT_LAYOUT } from '../src/shared/architecture-layout'
import { captureArchitecture } from '../src/main/architecture-review/capture'
import { analyzeCaptureTimed } from '../src/main/architecture-review/timed-analysis'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}
const LAYOUT = {
  version: 1,
  scope: ['src'],
  subsystems: [{ name: 'shell', paths: ['src/ui', 'src/app.ts'] }],
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hvir-architecture-layout-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'user.name', 'Test')
  const files: Record<string, string> = {
    'src/app.ts': "import './ui/view'\nimport './data/store'\n",
    'src/ui/view.ts': "import '../data/store'\n",
    'src/data/store.ts': 'export const store = 1\n',
    'scripts/tool.ts': "import '../src/data/store'\n",
    'tsconfig.json': '{"compilerOptions":{}}',
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
  }
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'baseline')
  const host = new LocalHost()
  return {
    root,
    writeLayout: async (value: unknown) => {
      await mkdir(join(root, '.hvir'), { recursive: true })
      await writeFile(
        join(root, '.hvir/architecture.json'),
        typeof value === 'string' ? value : JSON.stringify(value),
      )
    },
    commit: (message: string) => {
      git(root, 'add', '.')
      git(root, 'commit', '-m', message)
    },
    capture: (ends: { baseline?: string; current?: string } = { baseline: 'HEAD' }) =>
      captureArchitecture(
        host,
        { root: localPath(root), ...ends },
        new AbortController().signal,
      ),
  }
}

it('scans the whole repository with default subsystems when no layout file exists', async () => {
  const f = await fixture()
  const capture = await f.capture()
  expect(capture.layout).toEqual(ARCHITECTURE_DEFAULT_LAYOUT)
  expect(capture.after.map((file) => file.path)).toContain('scripts/tool.ts')
  const { analysis } = await analyzeCaptureTimed(capture)
  expect(analysis.modules.map((module) => [module.path, module.subsystem])).toEqual([
    ['scripts/tool.ts', 'scripts'],
    ['src/app.ts', 'src'],
    ['src/data/store.ts', 'src/data'],
    ['src/ui/view.ts', 'src/ui'],
  ])
})

it('applies the layout file of a commit Current to both ends', async () => {
  const f = await fixture()
  await f.writeLayout(LAYOUT)
  f.commit('layout')
  const capture = await f.capture({ baseline: 'HEAD~1', current: 'HEAD' })
  expect(capture.layout).toEqual({
    origin: 'override',
    scope: ['src'],
    sourceRoots: ['src'],
    systems: [],
    subsystems: LAYOUT.subsystems,
  })
  for (const side of [capture.before, capture.after])
    expect(side.map((file) => file.path)).toEqual([
      'src/app.ts',
      'src/data/store.ts',
      'src/ui/view.ts',
    ])
  // Configs outside the scope still configure resolution inside it.
  expect(capture.configs.after.map((file) => file.path)).toEqual(['tsconfig.json'])
  const { analysis } = await analyzeCaptureTimed(capture)
  expect(analysis.relationships.map((r) => [r.source, r.target, r.after])).toEqual([
    ['shell', 'src/data', 2],
  ])
})

it('reads an untracked layout file on a live Current and fingerprints its bytes', async () => {
  const f = await fixture()
  const without = await f.capture()
  await f.writeLayout(LAYOUT)
  const first = await f.capture()
  expect(first.layout.origin).toBe('override')
  expect(first.after.map((file) => file.path)).not.toContain('scripts/tool.ts')
  expect(first.fingerprint).not.toBe(without.fingerprint)
  await f.writeLayout({ ...LAYOUT, subsystems: [] })
  const second = await f.capture()
  expect(second.layout.subsystems).toEqual([])
  expect(second.fingerprint).not.toBe(first.fingerprint)
})

it('ignores a layout file only the Baseline carries', async () => {
  const f = await fixture()
  await f.writeLayout(LAYOUT)
  f.commit('layout')
  git(f.root, 'rm', '-q', '.hvir/architecture.json')
  f.commit('drop layout')
  const capture = await f.capture({ baseline: 'HEAD~1', current: 'HEAD' })
  expect(capture.layout).toEqual(ARCHITECTURE_DEFAULT_LAYOUT)
})

it('refuses an invalid layout file and names the file, the end and the field', async () => {
  const f = await fixture()
  await f.writeLayout({ version: 1, scope: ['../outside'] })
  await expect(f.capture()).rejects.toThrow(
    /^Invalid \.hvir\/architecture\.json at working tree: "scope\[0\]" must be a relative path/,
  )
  await f.writeLayout('{ "version": 1, ')
  await expect(f.capture()).rejects.toThrow(/at working tree: The file is not valid JSON/)
  f.commit('broken layout')
  await expect(f.capture({ baseline: 'HEAD~1', current: 'HEAD' })).rejects.toThrow(
    /^Invalid \.hvir\/architecture\.json at HEAD: The file is not valid JSON/,
  )
})

it('refuses a layout file that is a symbolic link', async () => {
  const f = await fixture()
  await mkdir(join(f.root, '.hvir'))
  await symlink('/etc/hostname', join(f.root, '.hvir/architecture.json'))
  await expect(f.capture()).rejects.toThrow(/symbolic link/)
  f.commit('linked layout')
  await expect(f.capture({ baseline: 'HEAD~1', current: 'HEAD' })).rejects.toThrow(
    /symbolic link/,
  )
})
