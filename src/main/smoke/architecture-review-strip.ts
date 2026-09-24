import type { BrowserWindow } from 'electron'
import type { ArchitectureReviewSmokeFixture } from './architecture-review-fixture'

/**
 * Steps the commit strip through real Chromium: pairwise by default, then against a locked
 * Baseline, and reads commit-pair evidence that live edits never make stale.
 */
export async function verifyArchitectureCommitStrip(
  win: BrowserWindow,
  fixture: ArchitectureReviewSmokeFixture,
): Promise<string> {
  const { parent, before, label } = fixture.history
  const result = (await win.webContents.executeJavaScript(`
    (async () => {
      const wait = async (read, what) => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const value = read();
          if (value) return value;
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        throw new Error('Timed out waiting for ' + what);
      };
      const surface = () => document.querySelector('[aria-label="Architecture review"]:not([hidden])');
      const strip = () => surface()?.querySelector('[aria-label="Commit strip"]');
      const button = (text) => [...strip().querySelectorAll('button')].find(node => node.textContent?.trim() === text);
      const commit = (revision) => strip()?.querySelector('button[title="' + revision + '"]');
      const scanned = async (baseline, current, what) => {
        await wait(() => {
          const summary = surface()?.querySelector('.architecture-review-metadata summary')?.textContent ?? '';
          const alert = surface()?.querySelector('[role="alert"]');
          if (alert) throw new Error(what + ' failed: ' + alert.textContent);
          return summary.includes(baseline + ' → ' + current) && surface().querySelector('.architecture-review-body');
        }, what);
      };
      (await wait(() => commit(${JSON.stringify(before)}), 'fixture commit on the strip')).click();
      await scanned(${JSON.stringify(parent)}, ${JSON.stringify(before)}, 'pairwise commit');
      if (commit(${JSON.stringify(before)}).getAttribute('aria-pressed') !== 'true') throw new Error('Strip does not mark the scanned Current commit');
      button('Next commit').click();
      await scanned(${JSON.stringify(before)}, ${JSON.stringify(label)}, 'pairwise step');
      commit(${JSON.stringify(before)}).click();
      await scanned(${JSON.stringify(parent)}, ${JSON.stringify(before)}, 'return to first fixture commit');
      strip().querySelector('input[type="checkbox"]').click();
      await wait(() => strip().textContent.includes('Baseline held at ' + ${JSON.stringify(parent.slice(0, 8))}), 'locked baseline');
      button('Next commit').click();
      await scanned(${JSON.stringify(parent)}, ${JSON.stringify(label)}, 'step against the locked baseline');
      const subsystem = await wait(() => [...surface().querySelectorAll('.architecture-subsystem')].find(node => node.querySelector('strong')?.textContent === 'architecture-smoke/ui'), 'commit-pair subsystem');
      subsystem.click();
      const module = await wait(() => [...surface().querySelectorAll('.architecture-module-list .architecture-module')].find(node => node.querySelector('span')?.textContent === ${JSON.stringify(fixture.selectedPath)}), 'commit-pair module');
      module.click();
      await wait(() => {
        const contents = [...surface().querySelectorAll('.architecture-evidence .cm-content')].map(node => node.textContent);
        const checking = surface().querySelector('.architecture-evidence')?.textContent?.includes('Checking snapshot freshness');
        return !checking && contents.some(text => text.includes('../old-data/item')) && !contents.some(text => text.includes('refreshed = true'));
      }, 'committed evidence');
      if (surface().querySelector('.architecture-review-stale')) throw new Error('A commit-pair snapshot turned stale after a live edit');
      strip().querySelector('input[type="checkbox"]').click();
      return 'pairwise, locked, commit-pair evidence';
    })()
  `)) as string
  console.log(`[smoke] architecture commit strip OK (${result})`)
  return result
}
