import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { hostPath, joinHostPath, type ProjectState } from '../../shared'
import type { ProjectHost } from '../project-host'

export async function verifyReviewCheckpointView(options: {
  readonly win: BrowserWindow
  readonly host: ProjectHost
  readonly state: ProjectState
  readonly publishState: (state: ProjectState) => void
}): Promise<string> {
  const { win, host, state, publishState } = options
  const prefix = join(tmpdir(), 'hvir-checkpoint-smoke-')
  const temporary = await host.exec('mktemp', ['-d', `${prefix}XXXXXX`])
  const directory = temporary.stdout.trim()
  if (temporary.code !== 0 || !directory.startsWith(prefix) || /[\r\n]/.test(directory))
    throw new Error('Cannot create isolated checkpoint smoke workspace')
  const root = hostPath(host.hostId, directory)
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await host.exec('git', ['-C', directory, ...args], { cwd: root })
    if (result.code !== 0) throw new Error(`Checkpoint smoke Git ${args[0]} failed`)
    return result.stdout.trim()
  }
  try {
    await git(['init', '-q', '-b', 'main'])
    await git(['config', 'user.name', 'Checkpoint Smoke'])
    await git(['config', 'user.email', 'checkpoint@example.invalid'])
    await host.writeFile(joinHostPath(root, 'review.txt'), 'checkpoint before\n')
    await git(['add', 'review.txt'])
    await git(['commit', '-qm', 'checkpoint fixture'])
    const originalHead = await git(['rev-parse', 'HEAD'])
    const originalIndex = await git(['hash-object', '--no-filters', '.git/index'])
    publishState(checkpointState(state, root))
    await waitFor(
      win,
      `document.querySelector('.git-panel .panel-meta')?.textContent === ${JSON.stringify(directory.split('/').at(-1))}`,
    )
    await waitFor(
      win,
      `(() => {
      const buttons = [...document.querySelectorAll('.rail-nav button')];
      return !buttons.some(button => button.textContent?.trim() === 'PRs') && buttons.some(button => button.textContent?.trim() === 'Files' && button.classList.contains('active'));
    })()`,
    )
    await click(win, '.rail-nav', 'Git')
    await waitFor(win, `document.querySelector('.git-panel')?.hidden === false`)
    await click(win, '.git-tabs', 'Since review')
    await waitFor(
      win,
      `document.querySelector('.review-checkpoint-panel')?.textContent?.includes('No review checkpoint saved.')`,
    )
    const beforeRead = await git(['count-objects', '-v'])
    await click(win, '.review-checkpoint-panel', 'Refresh')
    await idle(win)
    if ((await git(['count-objects', '-v'])) !== beforeRead)
      throw new Error('Checkpoint observation wrote Git objects')
    await click(win, '.review-checkpoint-panel', 'Save checkpoint')
    await waitFor(
      win,
      `document.querySelector('.review-checkpoint-panel')?.textContent?.includes('No changes since this checkpoint.')`,
    )
    const firstRef = await git([
      'for-each-ref',
      '--format=%(objectname)',
      'refs/worktree/hvir-review/',
    ])
    if (!/^[a-f0-9]{40,64}$/.test(firstRef))
      throw new Error('Checkpoint save did not produce one private tree ref')
    await host.writeFile(joinHostPath(root, 'review.txt'), 'checkpoint after\n')
    await click(win, '.review-checkpoint-panel', 'Refresh')
    await waitFor(
      win,
      `Boolean(document.querySelector('.review-checkpoint-files button'))`,
    )
    await click(win, '.review-checkpoint-files', 'review.txt', true)
    await waitFor(
      win,
      `(() => {
      const panel = document.querySelector('.review-checkpoint-panel');
      const lines = [...(panel?.querySelectorAll('.cm-line') ?? [])].map(line => line.textContent);
      return lines.includes('checkpoint before') && lines.includes('checkpoint after');
    })()`,
    )
    await click(win, '.review-checkpoint-panel', 'Advance checkpoint')
    await waitFor(
      win,
      `document.querySelector('.review-checkpoint-panel')?.textContent?.includes('No changes since this checkpoint.')`,
    )
    if (
      (await git([
        'for-each-ref',
        '--format=%(objectname)',
        'refs/worktree/hvir-review/',
      ])) === firstRef
    )
      throw new Error('Checkpoint advance retained the previous baseline')
    await click(win, '.review-checkpoint-panel', 'Clear')
    await waitFor(
      win,
      `document.querySelector('.review-checkpoint-panel')?.textContent?.includes('No review checkpoint saved.')`,
    )
    if (await git(['for-each-ref', '--format=%(refname)', 'refs/worktree/hvir-review/']))
      throw new Error('Checkpoint clear retained a private ref')
    if (
      (await git(['rev-parse', 'HEAD'])) !== originalHead ||
      (await git(['hash-object', '--no-filters', '.git/index'])) !== originalIndex
    )
      throw new Error('Checkpoint workflow modified HEAD or staging index')
    return 'checkpoint save + exact Chromium diff + advance + clear + unchanged HEAD/index'
  } finally {
    try {
      publishState(state)
      await click(win, '.git-tabs', 'Changes', true)
    } finally {
      await removeFixture(host, directory)
    }
  }
}

async function removeFixture(host: ProjectHost, directory: string): Promise<void> {
  const removed = await host.exec('rm', ['-rf', '--', directory])
  if (removed.code !== 0) throw new Error('Checkpoint smoke workspace cleanup failed')
}

function checkpointState(state: ProjectState, root: ProjectState['root']): ProjectState {
  const projectId = 'checkpoint-smoke-project'
  const workspaceId = 'checkpoint-smoke-workspace'
  return {
    ...state,
    root,
    activeProjectId: projectId,
    activeWorkspaceId: workspaceId,
    projects: [
      ...state.projects,
      {
        id: projectId,
        registeredRoot: root,
        displayName: 'Checkpoint smoke',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: workspaceId,
        workspaces: [
          {
            id: workspaceId,
            root,
            name: 'Checkpoint smoke',
            main: true,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  }
}

async function click(
  win: BrowserWindow,
  selector: string,
  label: string,
  prefix = false,
): Promise<void> {
  const textMatch = prefix
    ? `button.textContent?.trim().startsWith(${JSON.stringify(label)})`
    : `button.textContent?.trim() === ${JSON.stringify(label)}`
  const candidate = `([...document.querySelectorAll(${JSON.stringify(`${selector} button`)})]
    .find(button => ${textMatch}))`
  await waitFor(win, `${candidate} && !${candidate}.disabled`)
  await win.webContents.executeJavaScript(`${candidate}.click()`)
}

async function idle(win: BrowserWindow): Promise<void> {
  await waitFor(
    win,
    `document.querySelector('.review-checkpoint-panel')?.getAttribute('aria-busy') === 'false'`,
  )
}

async function waitFor(win: BrowserWindow, condition: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const result = (await win.webContents.executeJavaScript(`(() => {
      const error = document.querySelector('.review-checkpoint-panel .tree-error');
      return { ready: Boolean(${condition}), failed: Boolean(error) };
    })()`)) as { readonly ready: boolean; readonly failed: boolean }
    if (result.failed) throw new Error('Checkpoint UI reported a capability failure')
    if (result.ready) return
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  const state = (await win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.review-checkpoint-panel');
    return {
      panelPresent: Boolean(panel),
      busy: panel?.getAttribute('aria-busy') === 'true',
      gitHidden: document.querySelector('.git-panel')?.hasAttribute('hidden') ?? true,
      reviewSelected: [...document.querySelectorAll('.git-tabs button')].some(button => button.textContent?.trim() === 'Since review' && button.classList.contains('active'))
    };
  })()`)) as Record<string, boolean>
  throw new Error(
    `Checkpoint UI did not reach the expected state: ${JSON.stringify(state)}`,
  )
}
