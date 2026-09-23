import { joinHostPath, type HostPath } from '../../shared'
import { GitCommandContext } from '../git/git-command-context'
import type { ProjectHost } from '../project-host'

export interface ArchitectureReviewSmokeFixture {
  readonly root: HostPath
  readonly selectedPath: string
  readonly beforeSource: string
  readonly afterSource: string
}

/** Adds an index/live source pair with changed imports to the disposable smoke repository. */
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
    ],
    { cwd: root },
  )
  if (mkdir.code !== 0)
    throw new Error('Failed to create architecture smoke directories: ' + mkdir.stderr)
  const git = new GitCommandContext(host, root)
  for (const [relativePath, content] of Object.entries(beforeFiles))
    await host.writeFile(joinHostPath(root, relativePath), content)
  const staged = await git.mutate(root, [
    'add',
    '--',
    'architecture-smoke/ui/view.ts',
    'architecture-smoke/old-data/item.ts',
    'architecture-smoke/ui/code.ts',
  ])

  if (staged.code !== 0)
    throw new Error('Failed to stage architecture smoke fixture: ' + staged.stderr)
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

  return { root, selectedPath, beforeSource, afterSource }
}
