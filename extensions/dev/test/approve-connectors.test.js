import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  hostRunning,
  normalizeDeclaration,
  planApprovals,
  developmentInstallations,
  stamp,
  LIMITS,
} from '../approve-connectors.mjs'

const declaration = {
  id: 'gh',
  description: 'new description',
  context: 'workspace',
  setup: { executable: 'gh' },
  timeoutMs: 30000,
  outputBytes: 4194304,
  environment: ['GH_HOST', 'GH_CONFIG_DIR'],
}

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'hvir-approve-')))
  const bin = join(root, 'bin')
  await fs.mkdir(bin)
  await fs.writeFile(join(bin, 'gh'), '#!/bin/sh\n', { mode: 0o755 })
  await fs.writeFile(join(bin, 'plain'), '', { mode: 0o644 })
  await fs.symlink(join(bin, 'gh'), join(bin, 'gh-link'))
  const profile = join(root, 'profile')
  await fs.mkdir(join(profile, 'extension-state'), { recursive: true })
  await fs.mkdir(join(profile, 'extensions'))
  const packageDir = join(root, 'pulls')
  await fs.mkdir(packageDir)
  await fs.writeFile(
    join(packageDir, 'hvir-extension.json'),
    JSON.stringify({ id: 'hvir.pulls', connectors: [declaration] }),
  )
  await fs.symlink(packageDir, join(profile, 'extensions', 'pulls-dev'))
  await fs.writeFile(
    join(profile, 'extension-state', 'state.json'),
    JSON.stringify({
      installations: [
        {
          installationId: 'inst-1',
          packageId: 'hvir.pulls',
          source: 'pulls-dev',
          kind: 'development',
          enabled: true,
        },
        {
          installationId: 'inst-2',
          packageId: 'hvir.other',
          source: 'other',
          kind: 'managed',
          enabled: true,
        },
      ],
    }),
  )
  return { root, bin, profile, packageDir }
}

function savedApproval(overrides = {}) {
  return {
    installationId: 'inst-1',
    connector: 'gh',
    host: 'local',
    executable: '/nonexistent/gh',
    canonicalExecutable: '/nonexistent/gh',
    configuration: { args: ['--foo'], env: { GH_HOST: 'github.com', STALE: 'x' } },
    declaration: { ...normalizeDeclaration(declaration), description: 'old description' },
    ...overrides,
  }
}

test('normalizeDeclaration uses hvir key order with setup first', () => {
  assert.deepEqual(Object.keys(normalizeDeclaration(declaration)), [
    'setup',
    'id',
    'description',
    'context',
    'timeoutMs',
    'outputBytes',
    'environment',
  ])
  const withoutSetup = Object.fromEntries(
    Object.entries(declaration).filter(([name]) => name !== 'setup'),
  )
  assert.equal(Object.keys(normalizeDeclaration(withoutSetup))[0], 'id')
})

test('a stale declaration is re-stamped and the configuration survives', async () => {
  const { bin, profile } = await fixture()
  const installations = await developmentInstallations(profile)
  assert.equal(installations.length, 1)
  const saved = [savedApproval({ executable: join(bin, 'gh-link') })]
  const plan = await planApprovals({
    saved,
    installations,
    lookup: () => assert.fail('no lookup'),
  })
  assert.equal(plan.report[0].change, 'declaration-updated')
  const [approval] = plan.approvals
  assert.equal(approval.declaration.description, 'new description')
  assert.equal(approval.executable, join(bin, 'gh-link'))
  assert.equal(approval.canonicalExecutable, join(bin, 'gh'))
  assert.deepEqual(approval.configuration, {
    args: ['--foo'],
    env: { GH_HOST: 'github.com' },
  })
  assert.equal(plan.dropped, 0)
})

test('a missing executable is looked up on the login PATH', async () => {
  const { bin, profile } = await fixture()
  const installations = await developmentInstallations(profile)
  const plan = await planApprovals({
    saved: [savedApproval({ declaration: normalizeDeclaration(declaration) })],
    installations,
    lookup: (name) => join(bin, name),
  })
  assert.equal(plan.approvals[0].executable, join(bin, 'gh'))
  assert.equal(plan.report[0].change, 'executable-updated')
})

test('a non-executable target is refused', async () => {
  const { bin, profile } = await fixture()
  const installations = await developmentInstallations(profile)
  await assert.rejects(
    planApprovals({ saved: [], installations, lookup: () => join(bin, 'plain') }),
    /not an executable file/,
  )
})

test('an unchanged approval is reported unchanged and other hosts are retained', async () => {
  const { bin, profile } = await fixture()
  const installations = await developmentInstallations(profile)
  const current = savedApproval({
    executable: join(bin, 'gh'),
    canonicalExecutable: join(bin, 'gh'),
    configuration: { args: [], env: {} },
    declaration: normalizeDeclaration(declaration),
  })
  const remote = savedApproval({ host: 'ssh:box', connector: 'git' })
  const foreign = savedApproval({ installationId: 'inst-9' })
  const obsolete = savedApproval({ connector: 'removed' })
  const plan = await planApprovals({
    saved: [current, remote, foreign, obsolete],
    installations,
    lookup: () => assert.fail('no lookup'),
  })
  assert.equal(plan.report[0].change, 'unchanged')
  assert.deepEqual(
    plan.approvals.map((entry) => [entry.installationId, entry.connector, entry.host]),
    [
      ['inst-1', 'git', 'ssh:box'],
      ['inst-9', 'gh', 'local'],
      ['inst-1', 'gh', 'local'],
    ],
  )
  assert.equal(plan.dropped, 1)
})

test('stamp writes the store and check mode leaves it alone', async () => {
  const { bin, profile } = await fixture()
  const store = join(profile, 'extension-state', 'connectors.json')
  const lookup = (name) => join(bin, name)
  const checked = await stamp({ profile, check: true, lookup })
  assert.equal(checked.report[0].change, 'added')
  await assert.rejects(fs.access(store))
  await stamp({ profile, lookup })
  const written = JSON.parse(await fs.readFile(store, 'utf8'))
  assert.equal(written.length, 1)
  assert.equal(written[0].canonicalExecutable, join(bin, 'gh'))
  assert.ok(Buffer.byteLength(JSON.stringify(written)) < LIMITS.stateBytes)
})

test('hostRunning sees a process launched with the profile argument', async () => {
  const profile = join(tmpdir(), `hvir guard ${process.pid}`)
  const child = spawn('/bin/sh', [
    '-c',
    'sleep 30; exit 0',
    'sh',
    `--user-data-dir=${profile}`,
  ])
  await once(child, 'spawn')
  try {
    assert.equal(hostRunning(profile), true)
    assert.equal(hostRunning(`${profile}-other`), false)
  } finally {
    child.kill()
  }
})
