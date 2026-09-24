import type { BrowserWindow } from 'electron'
import type { ArchitectureReviewSmokeFixture } from './architecture-review-fixture'

/** Proves pinned evidence cannot be retargeted through the real renderer bridge. */
export async function verifyArchitectureReviewAuthority(
  win: BrowserWindow,
  fixture: ArchitectureReviewSmokeFixture,
): Promise<void> {
  await win.webContents.executeJavaScript(`
    (async () => {
      const root = ${JSON.stringify(fixture.root)};
      const path = { ...root, path: root.path + '/' + ${JSON.stringify(fixture.selectedPath)} };
      const reviewId = 'smoke-authority';
      const snapshot = await window.hvir.invoke('architecture-review:scan', { root, reviewId, baseline: 'HEAD' });
      const request = { root, reviewId, snapshotId: snapshot.id, path };
      const reject = async (channel, forged, label) => {
        let refused = false;
        try { await window.hvir.invoke(channel, forged); }
        catch (error) {
          if (!/active workspace|not evidence|unavailable|host|authorized|preview changed/i.test(String(error))) throw error;
          refused = true;
        }
        if (!refused) throw new Error('Architecture authority accepted ' + label);
      };
      try {
        const evidence = await window.hvir.invoke('architecture-review:evidence', request);
        if (evidence.stale || evidence.diff.currentInput.content !== ${JSON.stringify(fixture.afterSource)}) throw new Error('Authority fixture did not capture the selected source');
        for (const channel of ['architecture-review:evidence', 'architecture-review:prepare', 'architecture-review:handoff']) {
          await reject(channel, { ...request, root: { ...root, hostId: 'other-smoke-host' } }, 'another host root');
          await reject(channel, { ...request, root: { ...root, path: root.path + '-other-worktree' } }, 'another worktree root');
          await reject(channel, { ...request, path: { ...path, hostId: 'other-smoke-host' } }, 'same path on another host');
          await reject(channel, { ...request, path: { ...path, path: root.path + '-other-worktree/' + ${JSON.stringify(fixture.selectedPath)} } }, 'another worktree source');
        }
        await reject('architecture-review:commits', { root: { ...root, hostId: 'other-smoke-host' } }, 'a commit strip on another host');
        await reject('architecture-review:origin', { root: { ...root, hostId: 'other-smoke-host' } }, 'a handoff origin on another host');
        await reject('architecture-review:origin', { root: { ...root, path: root.path + '.hvir-worktrees/review-forged' } }, 'a handoff origin for another worktree');
        await reject('architecture-review:commits', { root: { ...root, path: root.path + '-other-worktree' } }, 'a commit strip for another worktree');
        const retained = await window.hvir.invoke('architecture-review:evidence', request);
        if (retained.snapshotId !== snapshot.id || retained.diff.currentInput.content !== evidence.diff.currentInput.content) throw new Error('Rejected requests changed the original evidence');
      } finally {
        await window.hvir.invoke('architecture-review:close', { root, reviewId });
      }
    })()
  `)
  console.log(
    '[smoke] architecture authority OK (host/worktree roots, strips and source paths rejected; original pinned evidence retained)',
  )
}
