import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  FLEET_CLASSIFICATION_NOTES_REF,
  fleetCommitChange,
  parseFleetClassification,
  readFleetClassifications,
} from '../src/main/architecture-review/fleet-classification'
import { architectureGitContext } from '../src/main/architecture-review/git-context'
import type { CommitDiffEntry } from '../src/main/architecture-review/commit-change'
import { ARCHITECTURE_DEFAULT_LAYOUT } from '../src/shared/architecture-layout'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath } from '../src/shared/host-path'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'hvir-fleet-classification-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.test')
  git(root, 'config', 'user.name', 'Test')
  const commit = async (message: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), content)
    }
    git(root, 'add', '-A')
    git(root, 'commit', '--allow-empty', '-m', message)
    return git(root, 'rev-parse', 'HEAD')
  }
  const note = (revision: string, text: string) =>
    git(
      root,
      'notes',
      `--ref=${FLEET_CLASSIFICATION_NOTES_REF}`,
      'add',
      '-m',
      text,
      revision,
    )
  const path = localPath(root)
  const context = architectureGitContext(
    new LocalHost(),
    path,
    new AbortController().signal,
  )
  const run = (args: readonly string[]) => context.run(path, args)
  return { root, commit, note, run }
}
const NOTE = [
  'Change-Type: Performance',
  'Change-Scope: subsystem',
  'Architectural: architectural',
  'Behavior: modification',
  'Compatibility: compatible',
  'Risk: medium',
  'Bead: hvir-abc',
  'Bead: hvir-def',
  'Classified-By: jev',
].join('\n')

it('reads the classification note of each commit and reports the rest as not classified', async () => {
  const r = await repository()
  const labelled = await r.commit('cache', { 'src/a.ts': 'export const a = 1\n' })
  const bare = await r.commit('plain', { 'src/b.ts': 'export const b = 1\n' })
  r.note(labelled, NOTE)
  const found = await readFleetClassifications(r.run, [bare, labelled])
  expect(found.has(bare)).toBe(false)
  expect(found.get(labelled)).toEqual({
    type: 'Performance',
    scope: 'subsystem',
    architectural: 'architectural',
    behavior: 'modification',
    compatibility: 'compatible',
    risk: 'medium',
    beads: ['hvir-abc', 'hvir-def'],
    classifiedBy: 'jev',
  })
})

it('reports nothing classified when the notes ref does not exist, without failing', async () => {
  const r = await repository()
  const one = await r.commit('one', { 'src/a.ts': 'export {}\n' })
  const two = await r.commit('two\n\nBead: hvir-xyz', { 'src/b.ts': 'export {}\n' })
  expect(git(r.root, 'for-each-ref', 'refs/notes/')).toBe('')
  const found = await readFleetClassifications(r.run, [two, one])
  expect(found.size).toBe(0)
})

it('reads trailers the commit carries itself and lets a note override them', async () => {
  const r = await repository()
  const self = await r.commit(
    'label\n\nChange-Type: Bug fix\nArchitectural: none\nRisk: low\nBead: hvir-1',
    { 'src/a.ts': 'export {}\n' },
  )
  const corrected = await r.commit(
    'relabel\n\nChange-Type: Refactor\nArchitectural: structural',
    { 'src/b.ts': 'export {}\n' },
  )
  r.note(
    corrected,
    'Change-Type: Architecture\nArchitectural: architectural\nClassified-By: jev',
  )
  const found = await readFleetClassifications(r.run, [self, corrected])
  expect(found.get(self)).toEqual({
    type: 'Bug fix',
    architectural: 'none',
    risk: 'low',
    beads: ['hvir-1'],
  })
  expect(found.get(corrected)).toEqual({
    type: 'Architecture',
    architectural: 'architectural',
    beads: [],
    classifiedBy: 'jev',
  })
})

it('leaves a commit unclassified when its note lacks a Change-Type, whatever its message says', async () => {
  const r = await repository()
  const labelled = await r.commit('label\n\nChange-Type: Feature\nRisk: low', {
    'src/a.ts': 'export {}\n',
  })
  const overridden = await r.commit('relabel\n\nChange-Type: Bug fix\nRisk: low', {
    'src/b.ts': 'export {}\n',
  })
  r.note(overridden, 'Reviewed by hand, not a classification.\n\nClassified-By: jev')
  const found = await readFleetClassifications(r.run, [labelled, overridden])
  expect(found.get(labelled)).toEqual({ type: 'Feature', risk: 'low', beads: [] })
  expect(found.has(overridden)).toBe(false)
})

it('asks Git nothing for an empty request', async () => {
  const run = vi.fn<(args: readonly string[]) => Promise<string>>()
  expect((await readFleetClassifications(run, [])).size).toBe(0)
  expect(run).not.toHaveBeenCalled()
})

it('needs a Change-Type, unfolds continuation lines and drops unusable values', () => {
  expect(parseFleetClassification('Bead: hvir-1\nClassified-By: jev')).toBeUndefined()
  expect(parseFleetClassification('')).toBeUndefined()
  expect(parseFleetClassification('Some prose about the change')).toBeUndefined()
  expect(
    parseFleetClassification(
      'change-type: Data model / persistence\n  and storage\nRisk:\t high\nBead: \nBead: x\u0007\nScope-note: ignored',
    ),
  ).toEqual({ type: 'Data model / persistence and storage', risk: 'high', beads: [] })
  expect(
    parseFleetClassification(`Change-Type: ${'x'.repeat(201)}\nChange-Type: Feature`),
  ).toEqual({ type: 'Feature', beads: [] })
  expect(parseFleetClassification('prose\n  Change-Type: Feature')).toBeUndefined()
})

it('marks architecture from the Architectural trailer and code or none from the diff', () => {
  const entry = (path: string, status = 'M'): CommitDiffEntry => ({
    path,
    status,
    before: 'a'.repeat(40),
    after: 'b'.repeat(40),
  })
  const layout = ARCHITECTURE_DEFAULT_LAYOUT
  const classified = (architectural?: string) => ({
    type: 'Performance',
    beads: [],
    ...(architectural === undefined ? {} : { architectural }),
  })
  expect(fleetCommitChange(classified('Architectural'), [], layout)).toBe('architecture')
  expect(
    fleetCommitChange(classified('structural'), [entry('src/a.ts', 'A')], layout),
  ).toBe('code')
  expect(fleetCommitChange(classified('none'), [entry('src/a.ts')], layout)).toBe('code')
  expect(fleetCommitChange(classified('none'), [entry('README.md')], layout)).toBe('none')
  expect(fleetCommitChange(classified(), [entry('src/a.ts')], layout)).toBe('code')
  expect(fleetCommitChange(classified(), [entry('tsconfig.json')], layout)).toBe('none')
})
