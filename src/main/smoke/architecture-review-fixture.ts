import { ARCHITECTURE_LAYOUT_FILE, joinHostPath, type HostPath } from '../../shared'
import { GitCommandContext } from '../git/git-command-context'
import type { ProjectHost } from '../project-host'

export interface ArchitectureReviewSmokeFixture {
  readonly root: HostPath
  readonly selectedPath: string
  readonly beforeSource: string
  readonly afterSource: string
  /** First-parent history the strip steps through: the fixture commits and their parent. */
  readonly history: {
    readonly parent: string
    readonly before: string
    readonly label: string
  }
}

const LABEL_PATH = 'architecture-smoke/ui/label.ts'

/**
 * The tracked layout file keeps the scan to the fixture and names subsystems by the first
 * directory under it, so `architecture-smoke/ui` is a subsystem, not all of the fixture.
 */
export const ARCHITECTURE_SMOKE_LAYOUT = `${JSON.stringify({
  version: 1,
  scope: ['architecture-smoke'],
  sourceRoots: ['architecture-smoke'],
})}\n`

/**
 * Untracked Python modules on the live side, inside an existing subsystem so the map keeps
 * its shape; the built worker must load the grammar to list them.
 */
const LIVE_PYTHON: Readonly<Record<string, string>> = {
  'architecture-smoke/ui/app.py': 'from . import helpers\nimport json\n',
  'architecture-smoke/ui/helpers.py': 'def helper():\n    return 1\n',
}

/**
 * Commits the before sources and a second step onto the disposable smoke repository, then
 * leaves a live source pair with changed imports on top of HEAD.
 */
export async function createArchitectureReviewSmokeFixture(
  host: ProjectHost,
  smokeRoot: HostPath,
): Promise<ArchitectureReviewSmokeFixture> {
  const root = smokeRoot
  const selectedPath = 'architecture-smoke/ui/view.ts'
  const beforeSource = [
    "import { item } from '../old-data/item'",
    '',
    'export const view = item',
    '',
  ].join('\n')
  const afterSource = [
    "import { item } from '../new-data/item'",
    "import external from '@vendor/external'",
    '',
    'export const view = `${item}:${external}`',
    '',
  ].join('\n')
  const beforeFiles: Readonly<Record<string, string>> = {
    [ARCHITECTURE_LAYOUT_FILE]: ARCHITECTURE_SMOKE_LAYOUT,
    [selectedPath]: beforeSource,
    'architecture-smoke/old-data/item.ts': 'export const item = "old"\n',
    'architecture-smoke/ui/code.ts': 'export const codeOnly = true\n',
  }

  const mkdir = await host.exec(
    'mkdir',
    [
      '-p',
      joinHostPath(root, 'architecture-smoke/ui').path,
      joinHostPath(root, 'architecture-smoke/old-data').path,
      joinHostPath(root, 'architecture-smoke/new-data').path,
      joinHostPath(root, '.hvir').path,
    ],
    { cwd: root },
  )
  if (mkdir.code !== 0)
    throw new Error('Failed to create architecture smoke directories: ' + mkdir.stderr)
  const git = new GitCommandContext(host, root)
  for (const [relativePath, content] of Object.entries(beforeFiles))
    await host.writeFile(joinHostPath(root, relativePath), content)
  const parent = await git.run(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const before = await commitFixture(
    git,
    root,
    'Add architecture smoke sources',
    Object.keys(beforeFiles),
  )
  await host.writeFile(
    joinHostPath(root, LABEL_PATH),
    "import { view } from './view'\n\nexport const label = `label:${view}`\n",
  )
  const label = await commitFixture(git, root, 'Add architecture smoke label', [
    LABEL_PATH,
  ])
  await host.writeFile(
    joinHostPath(root, 'architecture-smoke/ui/code.ts'),
    'export const codeOnly = false\n',
  )
  await host.writeFile(joinHostPath(root, selectedPath), afterSource)
  await host.removeFile(joinHostPath(root, 'architecture-smoke/old-data/item.ts'))
  await host.writeFile(
    joinHostPath(root, 'architecture-smoke/new-data/item.ts'),
    'export const item = "new"\n',
  )
  for (const [relativePath, content] of Object.entries(LIVE_PYTHON))
    await host.writeFile(joinHostPath(root, relativePath), content)

  return {
    root,
    selectedPath,
    beforeSource,
    afterSource,
    history: { parent: parent.trim(), before, label },
  }
}

async function commitFixture(
  git: GitCommandContext,
  root: HostPath,
  message: string,
  paths: readonly string[],
): Promise<string> {
  const staged = await git.mutate(root, ['add', '--', ...paths])
  if (staged.code !== 0)
    throw new Error('Failed to stage architecture smoke fixture: ' + staged.stderr)
  const committed = await git.mutate(root, [
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    message,
  ])
  if (committed.code !== 0)
    throw new Error('Failed to commit architecture smoke fixture: ' + committed.stderr)
  return (await git.run(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
}
