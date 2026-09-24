import type { BrowserWindow } from 'electron'
import { ARCHITECTURE_BRIEF_FILE } from '../../shared/architecture-handoff'
import { hostPath, joinHostPath, type HostPath } from '../../shared'
import { hvirWorktreeLocation } from '../git/hvir-worktrees'
import type { ProjectHost } from '../project-host'
import type { ArchitectureReviewSmokeFixture } from './architecture-review-fixture'

/**
 * A prepared commit-pair handoff refuses a forged workspace, an injected ref and an
 * escaping evidence path, and none of them creates a branch or a worktree.
 */
export async function verifyArchitectureHandoffAuthority(
  win: BrowserWindow,
  host: ProjectHost,
  fixture: ArchitectureReviewSmokeFixture,
): Promise<void> {
  const { root, selectedPath, history } = fixture
  await win.webContents.executeJavaScript(`
    (async () => {
      const root = ${JSON.stringify(root)};
      const path = { ...root, path: root.path + '/' + ${JSON.stringify(selectedPath)} };
      const reviewId = 'smoke-handoff-authority';
      const reviewer = (await window.hvir.invoke('harness:catalog', undefined)).find(provider => provider.architectureReviewLaunch);
      if (!reviewer) throw new Error('No provider supports an architecture review launch');
      await window.hvir.invoke('harness:profile-save', { root, input: { displayName: 'Smoke architecture reviewer', providerId: reviewer.id, scope: { kind: 'project', projectRoot: root }, executable: { kind: 'provider-default' }, args: [], environment: [], pathBindings: [], order: 30 } });
      const snapshot = await window.hvir.invoke('architecture-review:scan', { root, reviewId, baseline: ${JSON.stringify(history.parent)}, current: ${JSON.stringify(history.label)} });
      const request = { root, reviewId, snapshotId: snapshot.id, path };
      const reject = async (forged, label) => {
        let refused = false;
        try { await window.hvir.invoke('architecture-review:handoff', forged); }
        catch (error) {
          if (!/active workspace|preview changed|authorized|normalized/i.test(String(error))) throw error;
          refused = true;
        }
        if (!refused) throw new Error('Architecture handoff accepted ' + label);
      };
      try {
        const prepared = await window.hvir.invoke('architecture-review:prepare', request);
        if (prepared.handoff.commit !== ${JSON.stringify(history.label)}) throw new Error('Handoff does not start at the Current commit');
        const launch = { ...request, digest: prepared.digest };
        await reject({ ...launch, root: { ...root, path: prepared.handoff.worktree.path } }, 'the handoff worktree as the workspace');
        await reject({ ...launch, root: { ...root, path: root.path + '-other-worktree' } }, 'another workspace');
        await reject({ ...launch, digest: 'forged', current: '--upload-pack=touch /tmp/hvir-injected', branch: '--orphan', handoff: { ...prepared.handoff, branch: 'main', commit: 'HEAD~1' } }, 'an injected ref');
        await reject({ ...launch, path: { ...path, path: root.path + '/architecture-smoke/../../escape/view.ts' } }, 'an escaping evidence path');
        await reject({ ...launch, path: { ...path, path: root.path + '.hvir-worktrees/escape/view.ts' } }, 'evidence under the worktree location');
      } finally {
        await window.hvir.invoke('architecture-review:close', { root, reviewId });
      }
    })()
  `)
  await assertNoHandoffWorktree(host, root)
  console.log(
    '[smoke] architecture handoff authority OK (wrong workspace, injected ref and path escape refused; no branch or worktree created)',
  )
}

async function assertNoHandoffWorktree(host: ProjectHost, root: HostPath): Promise<void> {
  const refs = await host.exec('git', [
    '-C',
    root.path,
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads/hvir/',
  ])
  if (refs.code !== 0 || refs.stdout.trim() !== '')
    throw new Error(`A refused handoff left a branch: ${refs.stdout}${refs.stderr}`)
  const location = await host.exec('test', ['-e', hvirWorktreeLocation(root)])
  if (location.code === 0) throw new Error('A refused handoff created a worktree')
}

/**
 * Hands the commit-pair review off through the panel: the preview names the branch,
 * worktree, commit and brief; one click creates them; the brief stays untracked and
 * excluded; the person's own tree is unchanged.
 */
export async function verifyArchitectureHandoff(
  win: BrowserWindow,
  host: ProjectHost,
  fixture: ArchitectureReviewSmokeFixture,
): Promise<void> {
  const personStatus = await gitText(host, fixture.root, ['status', '--porcelain'])
  const preview = (await win.webContents.executeJavaScript(`
    (async () => {
      const wait = async (read, what) => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const alert = document.querySelector('.architecture-evidence [role="alert"]');
          if (alert) throw new Error(what + ' failed: ' + alert.textContent);
          const value = read();
          if (value) return value;
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        throw new Error('Timed out waiting for ' + what);
      };
      const evidence = () => document.querySelector('[aria-label="Architecture review"]:not([hidden]) .architecture-evidence');
      const button = (label) => [...(evidence()?.querySelectorAll('button') ?? [])].find(node => node.textContent?.trim() === label && !node.disabled);
      (await wait(() => button('Prepare agent handoff'), 'handoff preparation control')).click();
      const prompt = await wait(() => evidence().querySelector('pre[aria-label="Exact agent prompt"]'), 'handoff preview');
      const brief = evidence().querySelector('pre[aria-label="Snapshot brief"]')?.textContent ?? '';
      const text = evidence().textContent;
      const select = [...evidence().querySelectorAll('label')].find(node => node.textContent?.startsWith('Review profile'))?.querySelector('select');
      const option = [...(select?.options ?? [])].find(node => node.textContent === 'Smoke architecture reviewer');
      if (!option) throw new Error('The saved architecture review profile is not offered');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      (await wait(() => button('Create worktree and launch agent'), 'handoff control')).click();
      await wait(() => evidence()?.textContent?.includes('Agent worktree created'), 'created worktree');
      return { prompt: prompt.textContent, brief, text };
    })()
  `)) as { prompt: string; brief: string; text: string }
  const worktree = await assertHandoffWorktree(host, fixture, preview)
  const after = await gitText(host, fixture.root, ['status', '--porcelain'])
  if (after !== personStatus)
    throw new Error(`Handoff changed the person's tree:\n${personStatus}\n${after}`)
  console.log(`[smoke] architecture handoff OK (${worktree})`)
}

async function assertHandoffWorktree(
  host: ProjectHost,
  fixture: ArchitectureReviewSmokeFixture,
  preview: { prompt: string; brief: string; text: string },
): Promise<string> {
  const location = hvirWorktreeLocation(fixture.root)
  const listed = await host.exec('ls', ['-1', '--', location])
  const slugs = listed.stdout.split('\n').filter(Boolean)
  if (listed.code !== 0 || slugs.length !== 1)
    throw new Error(`Expected one handoff worktree in ${location}: ${listed.stdout}`)
  const worktree = hostPath(fixture.root.hostId, `${location}/${slugs[0]}`)
  const branch = `hvir/architecture/${slugs[0]}`
  if (!preview.text.includes(branch) || !preview.text.includes(worktree.path))
    throw new Error('Handoff preview did not name the created branch and worktree')
  if (!preview.prompt.includes(ARCHITECTURE_BRIEF_FILE))
    throw new Error('Agent prompt does not point at the snapshot brief')
  const head = await gitText(host, worktree, ['rev-parse', 'HEAD'])
  if (head !== fixture.history.label)
    throw new Error(`Handoff worktree starts at ${head}, not the Current commit`)
  const written = (
    await host.readFile(joinHostPath(worktree, ARCHITECTURE_BRIEF_FILE))
  ).toString('utf8')
  if (written !== preview.brief) throw new Error('Written brief differs from the preview')
  if ((await gitText(host, worktree, ['status', '--porcelain', '-uall'])) !== '')
    throw new Error('The snapshot brief shows as a change in the handoff worktree')
  const gitignore = await host.exec('git', [
    '-C',
    worktree.path,
    'check-ignore',
    '--no-index',
    '-v',
    ARCHITECTURE_BRIEF_FILE,
  ])
  if (!gitignore.stdout.includes('info/exclude'))
    throw new Error(`Brief is not excluded through info/exclude: ${gitignore.stdout}`)
  return `${branch} at ${head.slice(0, 8)}`
}

async function gitText(
  host: ProjectHost,
  root: HostPath,
  args: readonly string[],
): Promise<string> {
  const result = await host.exec('git', ['-C', root.path, ...args])
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}
