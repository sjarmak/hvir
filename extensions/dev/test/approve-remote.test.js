import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeDeclaration,
  planApprovals,
  remoteHostsFromProjects,
  resolveRemotes,
  stamp,
} from '../approve-connectors.mjs'

const gh = {
  id: 'gh',
  description: 'read pull requests',
  context: 'workspace',
  setup: { executable: 'gh' },
  timeoutMs: 30000,
  outputBytes: 4194304,
  environment: ['GH_HOST'],
}
const shell = { ...gh, id: 'shell', setup: { executable: 'zsh' }, environment: [] }
const installations = [
  {
    installationId: 'inst-1',
    packageId: 'hvir.pulls',
    packageDir: '/pkg',
    connectors: [gh, shell].map(normalizeDeclaration),
  },
]
const found = new Map([
  ['gh', { executable: '/usr/bin/gh', canonical: '/usr/bin/gh' }],
  ['/opt/old/gh', { executable: '/opt/old/gh', canonical: '/opt/old/real/gh' }],
])

function prior(overrides) {
  return {
    installationId: 'inst-1',
    connector: 'gh',
    host: 'work',
    executable: '/opt/old/gh',
    canonicalExecutable: '/opt/old/real/gh',
    configuration: { args: [], env: { GH_HOST: 'ghe.example' } },
    declaration: { ...normalizeDeclaration(gh), description: 'stale' },
    ...overrides,
  }
}

async function localFixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'hvir-remote-')))
  await fs.writeFile(join(root, 'gh'), '#!/bin/sh\n', { mode: 0o755 })
  await fs.writeFile(join(root, 'zsh'), '#!/bin/sh\n', { mode: 0o755 })
  return { root, lookup: (name) => join(root, name) }
}

test('a reachable host gets approvals for every tool it has and none for tools it lacks', async () => {
  const { lookup } = await localFixture()
  const plan = await planApprovals({
    saved: [],
    installations,
    lookup,
    remotes: { work: found },
  })
  const remote = plan.approvals.filter((entry) => entry.host === 'work')
  assert.deepEqual(
    remote.map((entry) => [entry.connector, entry.canonicalExecutable]),
    [['gh', '/usr/bin/gh']],
  )
  assert.deepEqual(
    plan.report
      .filter((row) => row.host === 'work')
      .map((row) => [row.connector, row.change]),
    [
      ['gh', 'added'],
      ['shell', 'missing'],
    ],
  )
})

test('a saved remote selection is kept over PATH discovery and its declaration is re-pinned', async () => {
  const { lookup } = await localFixture()
  const plan = await planApprovals({
    saved: [prior()],
    installations,
    lookup,
    remotes: { work: found },
  })
  const [remote] = plan.approvals.filter((entry) => entry.host === 'work')
  assert.equal(remote.executable, '/opt/old/gh')
  assert.equal(remote.canonicalExecutable, '/opt/old/real/gh')
  assert.equal(remote.declaration.description, 'read pull requests')
  assert.deepEqual(remote.configuration, { args: [], env: { GH_HOST: 'ghe.example' } })
  assert.equal(
    plan.report.find((row) => row.host === 'work').change,
    'declaration-updated',
  )
})

test('an unreachable host keeps its saved approvals with the current declaration', async () => {
  const { lookup } = await localFixture()
  const plan = await planApprovals({
    saved: [prior()],
    installations,
    lookup,
    remotes: { work: { unreachable: 'timed out' } },
  })
  const [remote] = plan.approvals.filter((entry) => entry.host === 'work')
  assert.equal(remote.canonicalExecutable, '/opt/old/real/gh')
  assert.equal(remote.declaration.description, 'read pull requests')
  assert.deepEqual(
    plan.report.filter((row) => row.host === 'work').map((row) => row.change),
    ['kept-unreachable', 'unreachable'],
  )
})

test('a tool that vanished from a reachable host keeps its saved approval', async () => {
  const { lookup } = await localFixture()
  const plan = await planApprovals({
    saved: [prior({ executable: '/gone/gh', canonicalExecutable: '/gone/gh' })],
    installations,
    lookup,
    remotes: { work: new Map() },
  })
  const [remote] = plan.approvals.filter((entry) => entry.host === 'work')
  assert.equal(remote.canonicalExecutable, '/gone/gh')
  assert.equal(plan.report.find((row) => row.host === 'work').change, 'kept-missing')
})

test('resolveRemotes turns a failing lookup into an unreachable marker', () => {
  const remotes = resolveRemotes({
    saved: [prior()],
    installations,
    hosts: ['work', 'down'],
    remoteLookup: (host, requests) => {
      if (host === 'down') throw new Error('no route')
      assert.deepEqual(requests.sort(), ['/opt/old/gh', 'gh', 'zsh'])
      return found
    },
  })
  assert.equal(remotes.work, found)
  assert.deepEqual(remotes.down, { unreachable: 'no route' })
})

test('remote hosts come from the registered projects and the configured list', async () => {
  const { root, lookup } = await localFixture()
  const profile = join(root, 'profile')
  await fs.mkdir(join(profile, 'extension-state'), { recursive: true })
  await fs.mkdir(join(profile, 'extensions'))
  const packageDir = join(root, 'pulls')
  await fs.mkdir(packageDir)
  await fs.writeFile(
    join(packageDir, 'hvir-extension.json'),
    JSON.stringify({ id: 'hvir.pulls', connectors: [gh] }),
  )
  await fs.symlink(packageDir, join(profile, 'extensions', 'pulls'))
  await fs.writeFile(
    join(profile, 'extension-state', 'state.json'),
    JSON.stringify({
      installations: [
        {
          installationId: 'inst-1',
          packageId: 'hvir.pulls',
          source: 'pulls',
          kind: 'development',
          enabled: true,
        },
      ],
    }),
  )
  await fs.writeFile(
    join(profile, 'projects.json'),
    JSON.stringify({
      projects: [{ hostId: 'local' }, { hostId: 'air-mbp' }, { hostId: 'air-mbp' }],
    }),
  )
  assert.deepEqual(await remoteHostsFromProjects(profile), ['air-mbp'])
  const asked = []
  const plan = await stamp({
    profile,
    lookup,
    hosts: ['work'],
    remoteLookup: (host) => {
      asked.push(host)
      return host === 'work'
        ? found
        : new Map([['gh', { executable: '/x/gh', canonical: '/x/gh' }]])
    },
  })
  assert.deepEqual(asked.sort(), ['air-mbp', 'work'])
  assert.deepEqual(
    plan.approvals.map((entry) => [entry.host, entry.canonicalExecutable]).sort(),
    [
      ['air-mbp', '/x/gh'],
      ['local', join(root, 'gh')],
      ['work', '/usr/bin/gh'],
    ],
  )
  assert.deepEqual(plan.unreachable, [])
})
