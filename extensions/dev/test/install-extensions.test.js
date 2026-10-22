import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
