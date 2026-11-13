import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import process from 'node:process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeApprovals } from '../approve-connectors.mjs'
import { installPackages, provision, readConfig } from '../install-extensions.mjs'

const manifest = {
  id: 'hvir.sample',
  connectors: [
    {
      id: 'tool',
      description: 'sample',
      context: 'workspace',
      setup: { executable: 'sample-tool' },
      timeoutMs: 1000,
      outputBytes: 1024,
      environment: [],
    },
  ],
}

function fakeValidate(_host, packageDir) {
  const revision = createHash('sha256').update(packageDir).digest('hex')
  return { packageId: manifest.id, revision }
}

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'hvir-install-')))
  const packageDir = join(root, 'pkg', 'sample')
  await fs.mkdir(join(packageDir, 'test'), { recursive: true })
  await fs.writeFile(join(packageDir, 'hvir-extension.json'), JSON.stringify(manifest))
  await fs.writeFile(join(packageDir, 'test', 'a.test.js'), '')
  const bin = join(root, 'bin')
  await fs.mkdir(bin)
  await fs.writeFile(join(bin, 'sample-tool'), '#!/bin/sh\n', { mode: 0o755 })
  const config = join(root, 'pkg', 'dev', 'install.json')
  await fs.mkdir(join(root, 'pkg', 'dev'))
  await fs.writeFile(
    config,
    JSON.stringify({
      agentAccess: { enabled: true, confirmDestructive: false },
      packages: [{ source: 'sample', path: '../sample', agentAccess: true }],
    }),
  )
  return { root, packageDir, bin, config, profile: join(root, 'profile') }
}

test('readConfig resolves package paths against the config file', async () => {
  const { config, packageDir } = await fixture()
  const { packages, agentAccess } = await readConfig(config)
  assert.deepEqual(packages, [{ source: 'sample', path: packageDir, agentAccess: true }])
  assert.deepEqual(agentAccess, { enabled: true, confirmDestructive: false })
})

test('installPackages links, retains, and records an enabled development installation', async () => {
  const { config, profile, packageDir } = await fixture()
  const { packages } = await readConfig(config)
  const { installations, report } = await installPackages({
    profile,
    host: '/nowhere',
    packages,
    validate: fakeValidate,
  })
  assert.equal(report[0].change, 'installed')
  assert.equal(report[0].retained, true)
  const [installation] = installations
  assert.match(installation.installationId, /^[a-f0-9-]{36}$/)
  assert.equal(installation.kind, 'development')
  assert.equal(installation.enabled, true)
  assert.equal(installation.agentAccess, true)
  const link = await fs.lstat(join(profile, 'extensions', 'sample'))
  const target = await fs.stat(packageDir)
  assert.equal(
    installation.sourceIdentity,
    `${link.dev}:${link.ino}:${target.dev}:${target.ino}`,
  )
  assert.equal(await fs.realpath(join(profile, 'extensions', 'sample')), packageDir)
  const retained = join(profile, 'extension-state', 'packages', installation.revision)
  assert.deepEqual((await fs.readdir(retained)).sort(), ['hvir-extension.json', 'test'])
  const written = JSON.parse(
    await fs.readFile(join(profile, 'extension-state', 'state.json'), 'utf8'),
  )
  assert.deepEqual(written, { installations, removals: [] })
})

test('a second run keeps the installation id and reports unchanged', async () => {
  const { config, profile } = await fixture()
  const { packages } = await readConfig(config)
  const first = await installPackages({
    profile,
    host: '',
    packages,
    validate: fakeValidate,
  })
  const second = await installPackages({
    profile,
    host: '',
    packages,
    validate: fakeValidate,
  })
  assert.equal(
    second.installations[0].installationId,
    first.installations[0].installationId,
  )
  assert.equal(second.report[0].change, 'unchanged')
  assert.equal(second.report[0].retained, false)
})

test('a link to a different package is never clobbered', async () => {
  const { root, config, profile } = await fixture()
  const other = join(root, 'other')
  await fs.mkdir(other)
  await fs.mkdir(join(profile, 'extensions'), { recursive: true })
  await fs.symlink(other, join(profile, 'extensions', 'sample'))
  const { packages } = await readConfig(config)
  await assert.rejects(
    installPackages({ profile, host: '', packages, validate: fakeValidate }),
    /points at .*other/,
  )
})

test('unrelated installations and removals survive provisioning', async () => {
  const { config, profile } = await fixture()
  const stateDir = join(profile, 'extension-state')
  await fs.mkdir(stateDir, { recursive: true })
  const foreign = {
    installationId: '11111111-1111-4111-8111-111111111111',
    packageId: 'hvir.other',
    source: 'other',
    sourceIdentity: '1:2',
    kind: 'directory',
    revision: 'a'.repeat(64),
    enabled: true,
    agentAccess: false,
  }
  await fs.writeFile(
    join(stateDir, 'state.json'),
    JSON.stringify({ installations: [foreign], removals: [{ source: 'gone' }] }),
  )
  const { packages } = await readConfig(config)
  const { installations } = await installPackages({
    profile,
    host: '',
    packages,
    validate: fakeValidate,
  })
  assert.deepEqual(installations[0], foreign)
  assert.equal(installations.length, 2)
  const written = JSON.parse(await fs.readFile(join(stateDir, 'state.json'), 'utf8'))
  assert.deepEqual(written.removals, [{ source: 'gone' }])
})

test('provision also stamps the connector approvals', async () => {
  const { config, profile, bin } = await fixture()
  const result = await provision({
    profile,
    host: '',
    config,
    validate: fakeValidate,
    lookup: (name) => join(bin, name),
  })
  assert.equal(result.approvals.report[0].change, 'added')
  const approvals = JSON.parse(
    await fs.readFile(join(profile, 'extension-state', 'connectors.json'), 'utf8'),
  )
  assert.equal(approvals[0].installationId, result.installations[0].installationId)
  assert.equal(approvals[0].canonicalExecutable, join(bin, 'sample-tool'))
  assert.equal(result.agentAccessWritten, true)
  assert.deepEqual(
    JSON.parse(await fs.readFile(join(profile, 'agent-access.json'), 'utf8')),
    {
      enabled: true,
      confirmDestructive: false,
    },
  )
  const again = await provision({
    profile,
    host: '',
    config,
    validate: fakeValidate,
    lookup: (name) => join(bin, name),
  })
  assert.equal(again.agentAccessWritten, false)
})

const answer = {
  id: 'hvir-answer',
  description: 'Record your answer',
  context: 'workspace',
  timeoutMs: 120000,
  outputBytes: 65536,
  environment: ['GC_CITY', 'PATH'],
  actions: ['answer-decision'],
}

function answerApproval(installationId, host) {
  return {
    installationId,
    connector: answer.id,
    host,
    executable: '/missing/hvir-answer',
    canonicalExecutable: '/missing/original/hvir-answer',
    configuration: { args: ['--selected'], env: { GC_CITY: '/chosen/city' } },
    declaration: { actions: [...answer.actions], ...answer },
  }
}

for (const host of ['local', 'work']) {
  for (const changed of [false, true]) {
    test(`provision preserves ${host} action approval unchanged, declaration changed: ${changed}`, async () => {
      const { config, profile, bin, packageDir } = await fixture()
      const manifestPath = join(packageDir, 'hvir-extension.json')
      const initial = { ...manifest, actionConnectors: [answer] }
      const settings = JSON.parse(await fs.readFile(config, 'utf8'))
      await fs.writeFile(config, JSON.stringify({ ...settings, hosts: ['work'] }))
      await fs.writeFile(manifestPath, JSON.stringify(initial))
      const options = {
        config, profile, host: '',
        lookup: (name) => join(bin, name),
        validate: (_host, directory) => ({
          packageId: manifest.id,
          revision: createHash('sha256').update(directory + 'before').digest('hex'),
        }),
        remoteLookup: (_host, requests) => {
          assert.deepEqual(requests, ['sample-tool'])
          return new Map()
        },
      }
      const first = await provision(options)
      const store = join(profile, 'extension-state', 'connectors.json')
      const saved = answerApproval(first.installations[0].installationId, host)
      const bytes = JSON.stringify(saved)
      assert.equal(first.approvals.approvals.some((row) => row.connector === answer.id), false)
      await fs.writeFile(store, JSON.stringify([...first.approvals.approvals, saved]))
      const updated = changed ? { ...answer, actions: ['another-action'], environment: [] } : answer
      await fs.writeFile(manifestPath, JSON.stringify({ ...initial, version: '2.0.0', actionConnectors: [updated] }))
      const result = await provision({ ...options, validate: fakeValidate })
      assert.equal(result.report[0].change, 'updated')
      const rows = JSON.parse(await fs.readFile(store, 'utf8'))
      assert.equal(JSON.stringify(rows.find((row) => row.connector === answer.id)), bytes)
      assert.equal(result.approvals.dropped, 0)
      assert.equal(result.approvals.report.some((row) => row.connector === answer.id), false)
      assert.equal(result.approvals.report[0].change, 'unchanged')
    })
  }
}

for (const seeded of [true, false]) {
  test(`provision writes private connector approvals, seeded: ${seeded}`, async (t) => {
    const { root, config, profile, bin } = await fixture()
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const store = join(profile, 'extension-state', 'connectors.json')
    await fs.mkdir(join(profile, 'extension-state'), { recursive: true })
    if (seeded) await fs.writeFile(store, '[]', { mode: 0o600 })
    const previous = process.umask(0o022)
    try {
      const result = await provision({
        config, profile, host: '', validate: fakeValidate,
        lookup: (name) => join(bin, name),
      })
      assert.deepEqual(JSON.parse(await fs.readFile(store, 'utf8')), result.approvals.approvals)
      assert.equal((await fs.stat(store)).mode & 0o777, 0o600)
    } finally {
      process.umask(previous)
    }
  })
}

for (const mask of [0o000, 0o777]) {
  test(`connector permissions are independent of umask ${mask.toString(8)}`, async (t) => {
    const { root, profile } = await fixture()
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    await fs.mkdir(join(profile, 'extension-state'), { recursive: true })
    const previous = process.umask(mask)
    try {
      const store = await writeApprovals(profile, [])
      assert.equal((await fs.stat(store)).mode & 0o777, 0o600)
    } finally {
      process.umask(previous)
    }
  })
}

test('failed connector rename preserves the store and removes the temporary file', async (t) => {
  const { root, profile } = await fixture()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const directory = join(profile, 'extension-state')
  await fs.mkdir(directory, { recursive: true })
  const store = join(directory, 'connectors.json')
  const original = '[{"configuration":{"args":["saved"],"env":{"TOKEN":"secret"}}}]'
  await fs.writeFile(store, original, { mode: 0o600 })
  const failure = new Error('simulated rename failure')
  t.mock.method(fs, 'rename', async () => { throw failure })
  await assert.rejects(writeApprovals(profile, []), (reason) => reason === failure)
  assert.equal(await fs.readFile(store, 'utf8'), original)
  assert.equal((await fs.stat(store)).mode & 0o777, 0o600)
  assert.deepEqual(await fs.readdir(directory), ['connectors.json'])
})
