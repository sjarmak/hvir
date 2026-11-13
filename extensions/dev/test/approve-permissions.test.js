import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { stamp, writeApprovals } from '../approve-connectors.mjs'

for (const mode of [0o400, 0o200, 0o000]) {
  test(`connector approvals preserve restrictive mode ${mode.toString(8)}`, async (t) => {
    const profile = await fs.mkdtemp(join(tmpdir(), 'hvir-permissions-'))
    t.after(() => fs.rm(profile, { recursive: true, force: true }))
    const directory = join(profile, 'extension-state')
    await fs.mkdir(directory)
    await fs.writeFile(join(directory, 'state.json'), '{"installations":[]}')
    const store = join(directory, 'connectors.json')
    await fs.writeFile(store, '[]')
    await fs.chmod(store, mode)
    const previous = process.umask(0o022)
    try {
      if (mode === 0o400) await stamp({ profile })
      else await writeApprovals(profile, [{ connector: 'saved' }])
      assert.equal((await fs.stat(store)).mode & 0o777, mode)
      await fs.chmod(store, 0o600)
      assert.deepEqual(JSON.parse(await fs.readFile(store, 'utf8')),
        mode === 0o400 ? [] : [{ connector: 'saved' }])
      assert.deepEqual((await fs.readdir(directory)).sort(), ['connectors.json', 'state.json'])
    } finally {
      process.umask(previous)
    }
  })
}
